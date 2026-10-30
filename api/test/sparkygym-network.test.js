import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { openIntegrationStore } from '../storage/integration-store.js'
import { createSparkyGymIntegration } from '../integrations/sparkygym.js'
import { derivePairKeys, signControl, signResponse, verifyControl, verifyResponse } from '../integrations/sparkygym-security.js'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)))
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
async function until(check) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) assert.fail('fixture delivery timed out'); await new Promise(resolve => setTimeout(resolve, 10)) } }
test('isolated HTTP/private fixture pairs with PSK, requires owner acceptance, verifies receipts and delivers native events', async t => {
  const id = randomUUID(), psk = randomBytes(32).toString('base64url'), sfNonce = randomBytes(32).toString('base64url')
  let binding, keys, service, sfOrigin, ogOrigin
  const received = [], controls = []
  const sf = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const bytes = Buffer.concat(chunks), value = bytes.length ? JSON.parse(bytes) : null, requestId = req.headers['x-sparkygym-request-id']
      assert.ok(requestId)
      let response
      if (req.url === '/api/integrations/v1/pair/claim') {
        assert.equal(req.headers['x-sparkygym-key-id'], id)
        assert.equal(verifyControl('POST', req.url, bytes, id, req.headers['x-sparkygym-timestamp'], req.headers['x-sparkygym-signature'], Buffer.from(psk, 'base64url'), req.headers['x-sparkygym-request-id']), true)
        binding = value; keys = derivePairKeys(psk, binding)
        response = { connection: { connection_id: id, status: 'pending_approval' } }
      } else if (req.url === '/api/integrations/v1/capabilities') {
        response = { version: 1, resources: ['body_measurement', 'exercise', 'workout'], max_event_bytes: 1048576, max_media_bytes: 104857600, media_mime_types: ['image/jpeg'] }
      } else if (req.url === '/api/integrations/v1/events') {
        received.push(value)
        response = { version: 1, event_id: value.event_id, status: 'applied', revision: value.revision }
      } else if (req.url === '/api/integrations/v1/snapshot') {
        controls.push(value)
        response = { version: 1, ...(value.snapshot_id ? { snapshot_id: value.snapshot_id } : {}), status: { begin: 'snapshot_started', complete: 'snapshot_complete', request: 'snapshot_queued' }[value.action] }
      } else throw new Error('unexpected fixture request')
      const body = Buffer.from(JSON.stringify(response)), timestamp = String(Math.floor(Date.now() / 1000)), keyId = id + '_sf'
      res.writeHead(200, { 'X-SparkyGym-Key-Id': keyId, 'X-SparkyGym-Request-Id': requestId, 'X-SparkyGym-Timestamp': timestamp, 'X-SparkyGym-Signature': signResponse(requestId, 200, body, keyId, timestamp, keys.incoming) }); res.end(body)
    } catch { res.writeHead(500); res.end('{}') }
  })
  const og = http.createServer(async (req, res) => { if (!await service.handle(req, res)) { res.writeHead(404); res.end() } })
  sfOrigin = await listen(sf); ogOrigin = await listen(og)
  const store = openIntegrationStore(':memory:')
  service = createSparkyGymIntegration({ store, secret: randomBytes(32).toString('hex'), origin: ogOrigin, readOwner: req => req.headers.authorization === 'Bearer owner-fixture' ? { id: 'owner-fixture' } : null, csrfOk: () => true })
  t.after(async () => { await service.stop(); await close(og); await close(sf); store.close() })
  service.start()
  const invitation = { version: 1, connection_id: id, sf_origin: sfOrigin, sf_owner_ref: 'sf-owner-fixture', sf_nonce: sfNonce, secret: psk, expires_at: new Date(Date.now() + 600000).toISOString(), peer_origin: ogOrigin, scopes: ['body_measurement', 'workout', 'exercise'], include_history: false }
  const claimed = await fetch(ogOrigin + '/api/integrations/sparkygym/claim', { method: 'POST', headers: { Authorization: 'Bearer owner-fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ invitation, allow_http: true, allow_private_network: true }) })
  assert.equal(claimed.status, 200)
  await until(() => !!binding)
  assert.equal(store.getConnection('owner-fixture', id).status, 'pending')
  const bytes = Buffer.from(JSON.stringify(binding)), timestamp = String(Math.floor(Date.now() / 1000)), keyId = id + '_sf', path = '/api/integrations/v1/pair/accept'
  const accepted = await fetch(ogOrigin + path, { method: 'POST', headers: { 'X-SparkyGym-Key-Id': keyId, 'X-SparkyGym-Request-Id': id, 'X-SparkyGym-Timestamp': timestamp, 'X-SparkyGym-Signature': signControl('POST', path, bytes, keyId, timestamp, keys.incoming, id) }, body: bytes })
  const responseBytes = Buffer.from(await accepted.arrayBuffer())
  assert.equal(accepted.status, 200)
  assert.equal(verifyResponse(id, 200, responseBytes, accepted.headers.get('x-sparkygym-key-id'), accepted.headers.get('x-sparkygym-timestamp'), accepted.headers.get('x-sparkygym-signature'), keys.outgoing), true)
  await until(() => controls.some(value => value.action === 'request'))
  store.commitProfile('owner-fixture', store.getRevision('owner-fixture'), { workouts: [{ id: 'fixture-workout', d: '2026-10-29', name: 'Fixture session', entries: [{ id: 'bench', sets: [{ w: 50, r: 5, done: true }] }] }] })
  service.afterCommitWake()
  await until(() => received.some(value => value.resource === 'workout'))
  assert.ok(received.find(value => value.resource === 'workout').payload.exercises[0].sets[0].set_id)
  assert.ok(received.every(value => Number.isSafeInteger(value.source_cursor)))
})
