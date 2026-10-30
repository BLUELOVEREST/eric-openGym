import { randomBytes, randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs'
import { isUuid, parseEvent, signRequest, verifyRequest } from './sparkygym-protocol.js'
import { derivePairKeys, sealCredentials, openCredentials, signControl, verifyControl, signResponse, verifyResponse } from './sparkygym-security.js'
import { hasManagedBodyFields } from './sparkygym-body-model.js'
import { sendPacket, validateDestination } from './sparkygym-transport.js'
import { validateSnapshot } from './sparkygym-snapshot.js'
import { encodeMediaFrame, PERSONAL_MEDIA_MIMES } from './sparkygym-media.js'

const OWNER = '/api/integrations/sparkygym'
const PEER = '/api/integrations/v1'
export const INTEGRATION_ROUTES = Object.freeze({
  'GET /api/body/profile': true,
  'GET /api/training-hints': true,
  'GET /api/integrations/sparkygym': true,
  'GET /api/integrations/sparkygym/notifications': true,
  'POST /api/integrations/sparkygym/claim': true,
  'POST /api/integrations/sparkygym/{connection_id}/pause': true,
  'POST /api/integrations/sparkygym/{connection_id}/resume': true,
  'POST /api/integrations/sparkygym/{connection_id}/revoke': true,
  'POST /api/integrations/sparkygym/{connection_id}/purge': true,
  'POST /api/integrations/sparkygym/{connection_id}/snapshot': true,
  'POST /api/integrations/v1/pair/accept': true,
  'POST /api/integrations/v1/events': true,
  'GET /api/integrations/v1/capabilities': true,
  'POST /api/integrations/v1/snapshot': true,
  'POST /api/integrations/v1/revoke': true,
})
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const jsonBytes = value => Buffer.from(JSON.stringify(value))
function reply(res, status, value, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(jsonBytes(value)) }
async function readBytes(req, limit = 1_048_576) {
  const chunks = []; let length = 0
  for await (const chunk of req) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > limit) fail('body_too_large', 413); chunks.push(bytes) }
  return Buffer.concat(chunks)
}
function parse(bytes) { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('invalid_json') } }
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const CAPABILITIES = Object.freeze({ version: 1, resources: ['body_definition', 'body_measurement', 'body_goal', 'exercise', 'workout', 'schedule_summary', 'personal_media'], max_event_bytes: 1_048_576, max_media_bytes: 104_857_600, media_mime_types: [...PERSONAL_MEDIA_MIMES] })
const pairFields = ['version', 'connection_id', 'sf_owner_ref', 'og_owner_ref', 'sf_origin', 'og_origin', 'sf_nonce', 'og_nonce', 'scopes', 'include_history']
function validatePair(value) {
  if (!exact(value, pairFields) || value.version !== 1 || !isUuid(value.connection_id) || typeof value.include_history !== 'boolean' || !Array.isArray(value.scopes) || !value.scopes.length || value.scopes.length > 7 || new Set(value.scopes).size !== value.scopes.length || !value.scopes.every(scope => CAPABILITIES.resources.includes(scope))) fail('invalid_pair')
  for (const field of ['sf_owner_ref', 'og_owner_ref']) if (typeof value[field] !== 'string' || !/^[^\x00-\x20\x7f]{1,200}$/.test(value[field])) fail('invalid_pair')
  for (const field of ['sf_nonce', 'og_nonce']) if (typeof value[field] !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value[field])) fail('invalid_pair')
  for (const field of ['sf_origin', 'og_origin']) { try { const url = new URL(value[field]); if (!['http:', 'https:'].includes(url.protocol) || value[field].replace(/\/$/, '') !== url.origin) fail('invalid_pair') } catch { fail('invalid_pair') } }
}
export function createSparkyGymIntegration({ store, secret, origin, readOwner, csrfOk, transport = sendPacket, mediaFile = () => null, onBodyChange = () => {} }) {
  if (!store || typeof secret !== 'string' || !secret.length || typeof readOwner !== 'function' || typeof csrfOk !== 'function') throw new TypeError('invalid_integration_options')
  let running = false, stopped = true, timer = null, wakeAgain = false
  const streams = new Set()
  let abort = new AbortController(), drainPromise = Promise.resolve()
  const readKey = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) fail('credentials_unavailable', 503)
    return Buffer.from(value, 'base64url')
  }
  const credentials = connection => {
    const value = openCredentials(secret, connection.id, connection.sealed_keys)
    if (value.version !== 1 || typeof value.incoming_key !== 'string' || typeof value.outgoing_key !== 'string') fail('credentials_unavailable', 503)
    return { incoming: readKey(value.incoming_key), outgoing: readKey(value.outgoing_key) }
  }
  function publicConnection(connection, forPeer = false) {
    const body = store.getBodyProfile(connection.owner_id)
    return { connection_id: connection.id, status: connection.status === 'pending' ? 'pending_approval' : connection.status === 'active' && connection.paused ? 'paused' : connection.status,
      peer_origin: connection.peer_origin, peer_owner_ref: connection.peer_user_id || null, scopes: connection.scopes, include_history: connection.binding?.include_history ?? false,
      affected_record_counts: forPeer ? {} : { body_definition: body.definitions.length, body_measurement: body.measurements.length, body_goal: body.target ? 1 : 0, schedule_summary: store.getTrainingHints(connection.owner_id).hints.length }, capabilities: connection.capabilities, delivery: store.deliveryStatus(connection.owner_id, connection.id) }
  }
  const getConnection = (owner, id) => { const connection = store.getConnection(owner, id); if (!connection) fail('connection_unavailable', 404); return connection }
  function signedReply(res, status, value, connection, requestId, scopedKeys = null) {
    const body = jsonBytes(value), timestamp = String(Math.floor(Date.now() / 1000)), keyId = connection.id + '_og'
    const signature = signResponse(requestId, status, body, keyId, timestamp, (scopedKeys || credentials(connection)).outgoing)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-SparkyGym-Key-Id': keyId, 'X-SparkyGym-Request-Id': requestId, 'X-SparkyGym-Timestamp': timestamp, 'X-SparkyGym-Signature': signature }); res.end(body)
  }
  function notify(owner) {
    onBodyChange(owner)
    for (const stream of streams) if (stream.owner === owner) stream.flush()
  }
  async function peer(req, res, path) {
    if (req.url !== path) fail('invalid_path')
    const bytes = await readBytes(req), keyId = req.headers['x-sparkygym-key-id']
    if (typeof keyId !== 'string' || !keyId.endsWith('_sf')) fail('unauthorized', 401)
    const connection = store.findPeerConnection(keyId.slice(0, -3))
    if (!connection?.sealed_keys || connection.status === 'revoked' && path !== PEER + '/revoke') fail('unauthorized', 401)
    if (connection.status === 'pending' && ![PEER + '/pair/accept', PEER + '/revoke'].includes(path)) fail('activation_pending', 503)
    let keys
    if (connection.revocation_receipt) {
      const scoped = openCredentials(secret, connection.id, connection.sealed_keys).revocation_receipt
      if (path !== PEER + '/revoke' || req.method !== 'POST' || scoped?.request_id !== req.headers['x-sparkygym-request-id'] || scoped.body_sha256 !== createHash('sha256').update(bytes).digest('hex')) fail('unauthorized', 401)
      keys = { incoming: readKey(scoped.incoming_key), outgoing: readKey(scoped.outgoing_key) }
    } else keys = credentials(connection)
    const timestamp = req.headers['x-sparkygym-timestamp'], signature = req.headers['x-sparkygym-signature']
    const requestId = req.headers['x-sparkygym-request-id']
    if (!isUuid(requestId)) fail('invalid_request_id')
    const valid = path === PEER + '/events' ? verifyRequest(bytes, keyId, timestamp, signature, keys.incoming) : verifyControl(req.method, path, bytes, keyId, timestamp, signature, keys.incoming, requestId)
    if (!valid) fail('unauthorized', 401)
    req.sparkyGymContext = { connection, requestId, keys }
    if (path === PEER + '/pair/accept' && req.method === 'POST') {
      const value = parse(bytes); validatePair(value)
      if (requestId !== connection.id) fail('invalid_request_id')
      if (!pairFields.every(field => JSON.stringify(value[field]) === JSON.stringify(connection.binding?.[field]))) fail('claim_conflict', 409)
      if (connection.status === 'pending') store.activateConnection(connection.owner_id, connection.id, sealCredentials(secret, connection.id, { version: 1, sf_nonce: value.sf_nonce, og_nonce: value.og_nonce, incoming_key: keys.incoming.toString('base64url'), outgoing_key: keys.outgoing.toString('base64url') }))
      notify(connection.owner_id)
      signedReply(res, 200, { connection: publicConnection(getConnection(connection.owner_id, connection.id), true) }, connection, connection.id)
      afterCommitWake(); return
    }
    if (path !== PEER + '/revoke' && (connection.status !== 'active' || connection.paused)) fail(connection.paused ? 'connection_paused' : 'activation_pending', 503)
    if (path === PEER + '/events' && req.method === 'POST') {
      const event = parseEvent(bytes)
      if (requestId !== event.event_id) fail('invalid_request_id')
      if (event.connection_id !== connection.id) fail('binding_mismatch', 403)
      const receipt = store.receiveIncoming(connection.owner_id, bytes)
      notify(connection.owner_id); signedReply(res, 200, receipt, connection, event.event_id); return
    }
    if (path === PEER + '/capabilities' && req.method === 'GET') { signedReply(res, 200, CAPABILITIES, connection, requestId); return }
    if (path === PEER + '/snapshot' && req.method === 'POST') {
      const value = parse(bytes)
      validateSnapshot(value, connection.scopes.filter(resource => resource.startsWith('body_') || resource === 'schedule_summary'))
      if (value.connection_id !== connection.id) fail('binding_mismatch', 403)
      const result = store.controlReceipt(connection.id, requestId, req.method, path, bytes, () => {
        if (value.action === 'request') return store.queueNativeSnapshot(connection.owner_id, connection.id, value.include_history)
        if (value.action === 'begin') return store.beginIncomingSnapshot(connection.owner_id, connection.id, value)
        return store.completeIncomingSnapshot(connection.owner_id, connection.id, value.snapshot_id)
      })
      notify(connection.owner_id); afterCommitWake(); signedReply(res, 200, result, connection, requestId); return
    }
    if (path === PEER + '/revoke' && req.method === 'POST') {
      const value = parse(bytes)
      if (!exact(value, ['version', 'connection_id']) || value.version !== 1 || value.connection_id !== connection.id) fail('invalid_control')
      const receipt = { request_id: requestId, body_sha256: createHash('sha256').update(bytes).digest('hex'), incoming_key: keys.incoming.toString('base64url'), outgoing_key: keys.outgoing.toString('base64url') }
      store.receiveRevocation(connection.owner_id, connection.id, requestId, sealCredentials(secret, connection.id, { version: 1, sf_nonce: connection.binding.sf_nonce, revocation_receipt: receipt }))
      signedReply(res, 200, { connection: publicConnection(getConnection(connection.owner_id, connection.id), true) }, connection, requestId, keys)
      notify(connection.owner_id); return
    }
    fail('unsupported_operation', 501)
  }
  async function claim(owner, value) {
    if (!exact(value, ['invitation', 'allow_http', 'allow_private_network']) || typeof value.allow_http !== 'boolean' || typeof value.allow_private_network !== 'boolean') fail('invalid_claim')
    const offer = value.invitation
    if (!exact(offer, ['version', 'connection_id', 'sf_origin', 'sf_owner_ref', 'sf_nonce', 'secret', 'expires_at', 'peer_origin', 'scopes', 'include_history']) || offer.version !== 1 || typeof offer.peer_origin !== 'string' || typeof offer.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(offer.secret) || typeof offer.expires_at !== 'string' || !Number.isFinite(Date.parse(offer.expires_at)) || new Date(offer.expires_at).toISOString() !== offer.expires_at || Date.parse(offer.expires_at) <= Date.now() || Date.parse(offer.expires_at) > Date.now() + 600_000) fail('invalid_invitation')
    if (offer.peer_origin.replace(/\/$/, '') !== origin.replace(/\/$/, '')) fail('peer_origin_mismatch')
    const binding = { version: 1, connection_id: offer.connection_id, sf_owner_ref: offer.sf_owner_ref, og_owner_ref: owner, sf_origin: offer.sf_origin, og_origin: origin, sf_nonce: offer.sf_nonce, og_nonce: randomBytes(32).toString('base64url'), scopes: offer.scopes, include_history: offer.include_history }
    validatePair(binding)
    await validateDestination(offer.sf_origin.replace(/\/$/, ''), { allow_insecure_http: value.allow_http, allow_private_network: value.allow_private_network })
    if (!store.getProfile(owner)) store.commitProfile(owner, 0, {})
    const previous = store.getConnection(owner, offer.connection_id)
    if (previous) fail('claim_exists', 409)
    const keys = derivePairKeys(offer.secret, binding)
    store.createConnection(owner, { id: offer.connection_id, peer_origin: offer.sf_origin.replace(/\/$/, ''), peer_user_id: offer.sf_owner_ref, scopes: offer.scopes, allow_insecure_http: value.allow_http }, {
      binding, sealed_keys: sealCredentials(secret, offer.connection_id, { version: 1, sf_nonce: binding.sf_nonce, og_nonce: binding.og_nonce, incoming_key: keys.incoming.toString('base64url'), outgoing_key: keys.outgoing.toString('base64url'), invitation_secret: offer.secret, expires_at: offer.expires_at }),
      allow_private_network: value.allow_private_network, body: jsonBytes(binding)
    })
    afterCommitWake()
    return { connection: publicConnection(getConnection(owner, offer.connection_id)) }
  }
  function beforeProfileWrite(owner, state, headers = {}) {
    const managed = store.getBodyProfile(owner).managed
    const paired = managed || store.listConnections(owner).some(connection => connection.status === 'active' && connection.binding)
    if (paired && headers['x-sparkygym-client-version'] !== '1') fail('client_upgrade_required', 409)
    if (managed) {
      if (hasManagedBodyFields(state)) fail('managed_body_fields', 409)
    }
    return []
  }
  async function handle(req, res) {
    const path = req.url.split('?')[0]
    if (path !== '/api/body/profile' && path !== '/api/training-hints' && path !== OWNER && !path.startsWith(OWNER + '/') && !path.startsWith(PEER + '/')) return false
    try {
      if (path.startsWith(PEER + '/')) { await peer(req, res, path); return true }
      const owner = readOwner(req)
      if (!owner?.id) fail('not_signed_in', 401)
      if (!csrfOk(req, req.method + ' ' + path)) fail('cross_origin_refused', 403)
      if (path === '/api/training-hints' && req.method === 'GET') {
        const url = new URL(req.url, origin)
        if ([...url.searchParams.keys()].some(key => key !== 'date') || url.searchParams.getAll('date').length > 1) fail('invalid_date')
        try { reply(res, 200, store.getTrainingHints(owner.id, url.searchParams.get('date'))) }
        catch (error) { if (error.message === 'invalid_date') fail('invalid_date'); throw error }
        return true
      }
      if (path === '/api/body/profile' && req.method === 'GET') { reply(res, 200, store.getBodyProfile(owner.id)); return true }
      if (path === OWNER && req.method === 'GET') { reply(res, 200, { connections: store.listConnections(owner.id).map(publicConnection) }); return true }
      if (path === OWNER + '/notifications' && req.method === 'GET') {
        const cursor = req.headers['last-event-id'] ?? new URL(req.url, origin).searchParams.get('cursor') ?? '0'
        if (!/^(0|[1-9]\d{0,15})$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) fail('invalid_cursor')
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
        const range = store.notificationRange(owner.id)
        if (Number(cursor) < range.floor || Number(cursor) > Math.max(range.latest, range.floor)) {
          const checkpoint = Math.max(range.latest, range.floor)
          res.end('id: ' + checkpoint + '\nevent: snapshot-required\ndata: ' + JSON.stringify({ revision: store.getBodyProfile(owner.id).revision, cursor: String(checkpoint) }) + '\n\n'); return true
        }
        res.write(': connected\n\n')
        let sessionTimer, closed = false
        const authorized = () => { try { return readOwner(req)?.id === owner.id } catch { return false } }
        const cleanup = () => { closed = true; clearInterval(sessionTimer); streams.delete(stream) }
        const stream = { owner: owner.id, cursor: Number(cursor), close() { if (!closed) { cleanup(); res.end() } }, flush() {
          if (closed) return
          if (!authorized()) { stream.close(); return }
          let rows
          do {
            rows = store.notifications(owner.id, stream.cursor)
            for (const row of rows) {
              if (!authorized()) { stream.close(); return }
              const writable = res.write('id: ' + row.cursor + '\nevent: ' + row.kind + '\ndata: ' + JSON.stringify(row.payload) + '\n\n')
              stream.cursor = row.cursor
              if (!writable) { stream.close(); return }
            }
          } while (rows.length === 500)
        } }
        // Authentication expiry/revocation must close idle streams too; no business reads.
        sessionTimer = setInterval(() => { if (!authorized()) stream.close() }, 30_000)
        sessionTimer.unref?.()
        streams.add(stream); res.on('close', cleanup); stream.flush(); return true
      }
      const bytes = await readBytes(req), value = parse(bytes)
      if (path === OWNER + '/claim' && req.method === 'POST') { reply(res, 200, await claim(owner.id, value)); return true }
      const match = /^\/api\/integrations\/sparkygym\/([0-9a-f-]{36})\/(pause|resume|revoke|purge|snapshot)$/.exec(path)
      if (!match || req.method !== 'POST') fail('not_found', 404)
      const [, id, action] = match
      getConnection(owner.id, id)
      if (action === 'snapshot') {
        if (!exact(value, ['include_history']) || typeof value.include_history !== 'boolean') fail('invalid_snapshot')
        store.queueTwoWaySnapshot(owner.id, id, value.include_history)
      }
      else if (action === 'purge') { if (!exact(value, ['confirm']) || value.confirm !== true) fail('confirmation_required'); store.purgeBody(owner.id, id, true) }
      else {
        if (!exact(value, [])) fail('invalid_control')
        if (action === 'revoke') store.revokeConnection(owner.id, id, jsonBytes({ version: 1, connection_id: id }))
        else store.pauseConnection(owner.id, id, action === 'pause')
      }
      notify(owner.id); afterCommitWake(); reply(res, 200, { connection: publicConnection(getConnection(owner.id, id)) })
    } catch (error) {
      const conflicts = ['source_rewind', 'event_conflict', 'control_conflict', 'snapshot_conflict']
      const status = error.status ?? ([...conflicts, 'profile_conflict', 'body_source_exists', 'snapshot_incomplete', 'snapshot_export_blocked'].includes(error.message) ? 409 : error instanceof TypeError ? 400 : 503)
      const value = { error: status === 503 ? 'integration_unavailable' : error.message }
      if (req.sparkyGymContext) {
        const { connection, requestId, keys } = req.sparkyGymContext
        if (conflicts.includes(error.message)) { store.markConflict(connection.owner_id, connection.id, error.message); notify(connection.owner_id) }
        signedReply(res, status, value, connection, requestId, keys)
      } else reply(res, status, value)
    }
    return true
  }
  async function deliver(connection, method, path, body, requestId, claimPacket = false) {
    const keys = credentials(connection), timestamp = String(Math.floor(Date.now() / 1000)), keyId = claimPacket ? connection.id : connection.id + '_og'
    let signingKey = keys.outgoing
    if (claimPacket) {
      const sealed = openCredentials(secret, connection.id, connection.sealed_keys)
      if (Date.parse(sealed.expires_at) <= Date.now()) fail('invitation_expired', 410)
      signingKey = Buffer.from(sealed.invitation_secret, 'base64url')
    }
    const signature = path === PEER + '/events' ? signRequest(body, keyId, timestamp, signingKey) : signControl(method, path, body, keyId, timestamp, signingKey, requestId)
    const response = await transport(connection.peer_origin, { allow_insecure_http: !!connection.allow_insecure_http, allow_private_network: !!connection.allow_private_network }, { method, path, body, signal: abort.signal, headers: { 'Content-Type': path === PEER + '/media' ? 'application/octet-stream' : 'application/json', 'X-SparkyGym-Request-Id': requestId, 'X-SparkyGym-Key-Id': keyId, 'X-SparkyGym-Timestamp': timestamp, 'X-SparkyGym-Signature': signature,
      ...(path === PEER + '/media' ? { 'X-SparkyGym-Body-SHA256': createHash('sha256').update(body).digest('hex') } : {}) } })
    const signed = response.headers['x-sparkygym-key-id'] === connection.id + '_sf' && response.headers['x-sparkygym-request-id'] === requestId && verifyResponse(requestId, response.status, response.body, response.headers['x-sparkygym-key-id'], response.headers['x-sparkygym-timestamp'], response.headers['x-sparkygym-signature'], keys.incoming)
    const wait = response.headers['retry-after'], waitSeconds = typeof wait === 'string' && /^\d+$/.test(wait) ? Number(wait) : 0
    if (!signed || response.status >= 400) {
      const status = !signed ? [401, 403].includes(response.status) ? response.status : 503 : response.status
      let code = signed ? 'peer_rejected' : 'invalid_peer_receipt'
      if (signed) {
        try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); if (typeof value.error === 'string' && /^[a-z_]{1,64}$/.test(value.error)) code = value.error } catch {}
      }
      throw Object.assign(new Error(code), { status, code, retryAfterMs: Number.isFinite(waitSeconds) ? Math.min(3_600_000, Math.max(0, waitSeconds * 1000)) : 0 })
    }
    return parse(response.body)
  }
  const retryAt = attempts => Date.now() + Math.min(3_600_000, 1000 * 2 ** Math.min(attempts, 12)) + Math.floor(Math.random() * 1000)
  async function drain() {
    if (running || stopped) { wakeAgain = true; return }
    running = true
    try {
      for (const job of store.pendingControls()) {
        if (stopped) break
        const connection = getConnection(job.owner_id, job.connection_id)
        try {
          const result = await deliver(connection, job.method, job.path, job.body, job.request_id, job.path === PEER + '/pair/claim')
          if (job.path === PEER + '/capabilities') {
            if (!exact(result, ['version', 'resources', 'max_event_bytes', 'max_media_bytes', 'media_mime_types']) || result.version !== 1 || !Array.isArray(result.resources) || !result.resources.length || new Set(result.resources).size !== result.resources.length || !result.resources.every(resource => CAPABILITIES.resources.includes(resource)) || !Number.isSafeInteger(result.max_event_bytes) || result.max_event_bytes < 1 || result.max_event_bytes > CAPABILITIES.max_event_bytes || !Number.isSafeInteger(result.max_media_bytes) || result.max_media_bytes < 1 || result.max_media_bytes > CAPABILITIES.max_media_bytes || !Array.isArray(result.media_mime_types) || result.media_mime_types.length > 32 || !result.media_mime_types.every(mime => typeof mime === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime))) fail('invalid_peer_receipt', 503)
            store.saveCapabilities(job.owner_id, connection.id, result)
          } else if (job.path === PEER + '/snapshot') {
            const action = parse(job.body).action
            const expected = { request: 'snapshot_queued', begin: 'snapshot_started', complete: 'snapshot_complete' }[action]
            if (result.version !== 1 || result.status !== expected || (action !== 'request' && result.snapshot_id !== parse(job.body).snapshot_id)) fail('invalid_peer_receipt', 503)
          } else if (result.connection?.connection_id !== connection.id || !['pending_approval', 'active', 'paused', 'revoked'].includes(result.connection.status)) fail('invalid_peer_receipt', 503)
          store.finishControl(job.request_id, 'delivered')
          if (job.path === PEER + '/snapshot' && result.status === 'snapshot_complete') store.confirmReplacementSnapshot(job.owner_id, connection.id, result.snapshot_id)
          if (job.path === PEER + '/revoke') store.clearRevokedKeys(job.owner_id, connection.id)
          notify(job.owner_id)
        }
        catch (error) {
          if (job.path === PEER + '/pair/claim' && getConnection(job.owner_id, job.connection_id).status !== 'pending') continue
          if ([401, 403].includes(error.status) && connection.status === 'active') store.pauseConnection(job.owner_id, job.connection_id, true)
          store.finishControl(job.request_id, error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status) ? 'terminal' : 'pending', Math.max(retryAt(job.attempts), Date.now() + (error.retryAfterMs || 0)), error.message === 'invitation_expired' ? 'invitation_expired' : 'control_delivery_failed')
        }
      }
      for (const owner of store.listProfiles()) for (const job of store.pending(owner)) {
        if (stopped) break
        const connection = getConnection(owner, job.connection_id)
        try { const receipt = await deliver(connection, 'POST', PEER + '/events', job.body, job.event_id); store.acknowledge(owner, job.event_id, receipt); notify(owner) }
        catch (error) {
          if (error.code === 'source_rewind') store.markConflict(owner, job.connection_id, 'source_rewind')
          else if ([401, 403].includes(error.status)) store.pauseConnection(owner, job.connection_id, true)
          else if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) { store.terminalEvent(owner, job.event_id, 'peer_payload_rejected'); store.pauseConnection(owner, job.connection_id, true) }
          else store.retry(owner, job.event_id, Math.max(retryAt(job.attempts), Date.now() + (error.retryAfterMs || 0)), 'delivery_failed')
        }
      }
      for (const job of store.pendingMedia()) {
        if (stopped) break
        const connection = getConnection(job.owner_id, job.connection_id)
        try {
          const file = mediaFile(job.owner_id, job.metadata.sha256)
          if (!connection.capabilities) fail('capabilities_not_ready', 503)
          if (job.metadata.bytes > connection.capabilities.max_media_bytes || !connection.capabilities.media_mime_types.includes(job.metadata.mime)) fail('media_not_negotiated', 422)
          if (!file || file.size !== job.metadata.bytes || file.mime !== job.metadata.mime) fail('media_not_ready', 503)
          const fd = fs.openSync(file.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
          let bytes
          try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size !== job.metadata.bytes || stat.size > CAPABILITIES.max_media_bytes) fail('media_not_ready', 503); bytes = fs.readFileSync(fd) } finally { fs.closeSync(fd) }
          const frame = encodeMediaFrame(job.metadata, bytes)
          const result = await deliver(connection, 'POST', PEER + '/media', frame, job.request_id)
          if (!exact(result, ['version', 'media_id', 'sha256', 'status']) || result.version !== 1 || result.media_id !== job.metadata.media_id || result.sha256 !== job.metadata.sha256 || result.status !== 'ready') fail('invalid_peer_receipt', 503)
          store.finishMedia(job.request_id, 'ready'); notify(job.owner_id)
        } catch (error) {
          if ([401, 403].includes(error.status)) store.pauseConnection(job.owner_id, job.connection_id, true)
          store.finishMedia(job.request_id, error.status === 422 ? 'terminal' : 'pending', Math.max(retryAt(job.attempts), Date.now() + (error.retryAfterMs || 0)), error.status === 422 ? 'media_not_negotiated' : 'media_delivery_pending')
        }
      }
    } finally {
      running = false
      if (!stopped) {
        const deadline = store.nextDeliveryAt()
        if (wakeAgain) { wakeAgain = false; afterCommitWake() }
        else if (deadline !== null) { timer = setTimeout(() => { timer = null; drainPromise = drain().catch(() => {}) }, Math.max(1, Math.min(2_147_483_647, deadline - Date.now()))); timer.unref?.() }
      }
    }
  }
  function afterCommitWake() { if (stopped) return; for (const stream of streams) stream.flush(); if (timer) clearTimeout(timer); timer = null; if (running) wakeAgain = true; else drainPromise = drain().catch(() => {}) }
  return Object.freeze({ handle, beforeProfileWrite, afterCommitWake, start() { if (!stopped) return; abort = new AbortController(); stopped = false; afterCommitWake() }, async stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; abort.abort(); for (const stream of streams) stream.close(); streams.clear(); await drainPromise } })
}
