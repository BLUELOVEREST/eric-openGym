import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { openIntegrationStore } from '../storage/integration-store.js'
import { createSparkyGymIntegration } from '../integrations/sparkygym.js'
import { sealCredentials, openCredentials, derivePairKeys, signControl, verifyResponse } from '../integrations/sparkygym-security.js'
import { randomUUID } from 'node:crypto'

const id = '22222222-2222-4222-8222-222222222222'
const scopes = ['body_definition', 'body_measurement', 'body_goal', 'exercise', 'workout', 'schedule_summary', 'personal_media']
const binding = { version: 1, connection_id: id, sf_owner_ref: 'sf-owner', og_owner_ref: 'owner', sf_origin: 'https://sf.example', og_origin: 'https://og.example', sf_nonce: Buffer.alloc(32, 1).toString('base64url'), og_nonce: Buffer.alloc(32, 2).toString('base64url'), scopes, include_history: true }
function setup(t) {
  const store = openIntegrationStore(':memory:'); t.after(() => store.close())
  store.commitProfile('owner', 0, { workouts: [] })
  const service = createSparkyGymIntegration({ store, secret: 'persistent', origin: 'https://og.example', readOwner: req => req.owner, csrfOk: () => true })
  t.after(() => service.stop())
  return { store, service }
}
async function request(service, method, url, body, owner, headers = {}) {
  const req = { method, url, owner, headers, async *[Symbol.asyncIterator]() { if (body) yield body } }
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) }, end(body) { this.body = body } }
  assert.equal(await service.handle(req, res), true)
  return { ...res, json: res.body ? JSON.parse(res.body.toString()) : null }
}
const invitation = () => ({ version: 1, connection_id: id, sf_origin: 'http://192.168.1.20:3010', sf_owner_ref: 'sf-owner', sf_nonce: binding.sf_nonce, secret: Buffer.alloc(32, 3).toString('base64url'), expires_at: new Date(Date.now() + 300000).toISOString(), peer_origin: 'http://192.168.1.21:3000', scopes, include_history: true })
test('claim uses invitation LAN origins independently of browser origin and derives network policy', async t => {
  const { service, store } = setup(t), offer = invitation()
  const response = await request(service, 'POST', '/api/integrations/sparkygym/claim', Buffer.from(JSON.stringify({ invitation: offer })), { id: 'owner' })
  assert.equal(response.status, 200)
  const connection = store.getConnection('owner', id)
  assert.equal(connection.binding.og_origin, offer.peer_origin)
  assert.equal(connection.binding.sf_origin, offer.sf_origin)
  assert.equal(!!connection.allow_insecure_http, true)
  assert.equal(!!connection.allow_private_network, true)
})
test('claim rejects legacy requests, partial authorization and unsafe destinations before persistence', async t => {
  const { service, store } = setup(t)
  const offers = [
    { invitation: invitation(), allow_http: true, allow_private_network: true },
    ...[{ scopes: scopes.slice(1) }, { include_history: false }, { scopes: [...scopes.slice(1), scopes[1]] },
      { sf_origin: 'http://169.254.169.254' }, { peer_origin: 'http://169.254.169.254' },
      { peer_origin: 'http://100.100.100.200' }, { sf_origin: 'http://[fd00:ec2::254]' },
      { peer_origin: 'http://192.168.1.21/path' }].map(change => ({ invitation: { ...invitation(), ...change } })),
  ]
  for (const value of offers) {
    const response = await request(service, 'POST', '/api/integrations/sparkygym/claim', Buffer.from(JSON.stringify(value)), { id: 'owner' })
    assert.equal(response.status, 400, JSON.stringify(value))
    assert.equal(store.getConnection('owner', id), null)
  }
})
test('LAN policy does not weaken owner CSRF or paired HMAC authentication', async t => {
  const { store } = setup(t)
  const service = createSparkyGymIntegration({ store, secret: 'persistent', origin: 'https://og.example', readOwner: req => req.owner, csrfOk: () => false })
  t.after(() => service.stop())
  const response = await request(service, 'POST', '/api/integrations/sparkygym/claim', Buffer.from(JSON.stringify({ invitation: invitation() })), { id: 'owner' })
  assert.equal(response.status, 403)
  assert.equal(store.getConnection('owner', id), null)
  assert.equal((await request(service, 'POST', '/api/integrations/v1/snapshot', Buffer.from('{}'), null, {})).status, 401)
})
test('concurrent owner/peer full requests are guarded, authenticated peer retries replay their receipt', async t => {
  const { service, store } = setup(t), keys = derivePairKeys(Buffer.alloc(32, 3).toString('base64url'), binding)
  const sealed = sealCredentials('persistent', id, { version: 1, incoming_key: keys.incoming.toString('base64url'), outgoing_key: keys.outgoing.toString('base64url') })
  store.createConnection('owner', { id, peer_origin: binding.sf_origin, peer_user_id: binding.sf_owner_ref, scopes })
  store.prepareConnection('owner', id, binding, sealed); store.activateConnection('owner', id, sealed)
  const flush = () => { while (store.pendingControls().length) for (const job of store.pendingControls()) store.finishControl(job.request_id, 'delivered') }
  flush()
  const path = '/api/integrations/v1/snapshot', bytes = Buffer.from(JSON.stringify({ version: 1, action: 'request', connection_id: id, include_history: true }))
  const timestamp = String(Math.floor(Date.now() / 1000)), requestId = randomUUID()
  const headers = { 'x-sparkygym-request-id': requestId, 'x-sparkygym-key-id': id + '_sf', 'x-sparkygym-timestamp': timestamp, 'x-sparkygym-signature': signControl('POST', path, bytes, id + '_sf', timestamp, keys.incoming, requestId) }
  const ownerRequest = () => request(service, 'POST', '/api/integrations/sparkygym/' + id + '/snapshot', Buffer.from('{"include_history":true}'), { id: 'owner' })
  const ownerResults = await Promise.all([ownerRequest(), ownerRequest()])
  assert.deepEqual(ownerResults.map(result => result.status).sort(), [200, 409])
  const first = await request(service, 'POST', path, bytes, null, headers)
  assert.equal(first.status, 200)
  assert.equal(store.getConnection('owner', id).paused, 0)
  assert.deepEqual((await request(service, 'POST', path, bytes, null, headers)).json, first.json)
  const otherId = randomUUID(), otherHeaders = { ...headers, 'x-sparkygym-request-id': otherId, 'x-sparkygym-signature': signControl('POST', path, bytes, id + '_sf', timestamp, keys.incoming, otherId) }
  const second = await request(service, 'POST', path, bytes, null, otherHeaders)
  assert.equal(second.status, 200)
  assert.deepEqual(second.json, first.json)
  assert.equal(verifyResponse(otherId, 200, second.body, second.headers['X-SparkyGym-Key-Id'], second.headers['X-SparkyGym-Timestamp'], second.headers['X-SparkyGym-Signature'], keys.outgoing), true)
  assert.equal((await ownerRequest()).status, 409)
  assert.equal((await request(service, 'POST', path, bytes, null, { ...headers, 'x-sparkygym-signature': 'v1=' + '0'.repeat(64) })).status, 401)
})
test('factory exposes stable lifecycle hooks and owner routes are authenticated', async t => {
  const { service } = setup(t)
  for (const key of ['handle', 'beforeProfileWrite', 'afterCommitWake', 'start', 'stop']) assert.equal(typeof service[key], 'function')
  assert.equal((await request(service, 'GET', '/api/integrations/sparkygym')).status, 401)
  assert.deepEqual((await request(service, 'GET', '/api/integrations/sparkygym', null, { id: 'owner' })).json, { connections: [] })
  assert.equal((await request(service, 'GET', '/api/body/profile', null, { id: 'owner' })).json.managed, false)
})
test('training hints require owner auth and expose unfiltered metadata or a validated calendar date', async t => {
  const { service } = setup(t)
  assert.equal((await request(service, 'GET', '/api/training-hints')).status, 401)
  assert.deepEqual((await request(service, 'GET', '/api/training-hints', null, { id: 'owner' })).json, { revision: 0, date: null, hints: [] })
  assert.deepEqual((await request(service, 'GET', '/api/training-hints?date=2026-11-02', null, { id: 'owner' })).json, { revision: 0, date: '2026-11-02', hints: [] })
  for (const query of ['date=2026-02-30', 'date=', 'date=2026-11-02&date=2026-11-03', 'owner=another']) {
    assert.equal((await request(service, 'GET', '/api/training-hints?' + query, null, { id: 'owner' })).status, 400)
  }
})
test('notification streams revalidate the original session and close after its revocation', async t => {
  const { service } = setup(t)
  let heartbeat
  t.mock.method(globalThis, 'setInterval', callback => { heartbeat = callback; return { unref() {} } })
  const req = { method: 'GET', url: '/api/integrations/sparkygym/notifications', headers: {}, owner: { id: 'owner' } }
  const res = new EventEmitter()
  const writes = []; let ended = false
  Object.assign(res, { writeHead() {}, write(value) { writes.push(value); return true }, end() { ended = true; this.emit('close') } })
  await service.handle(req, res)
  assert.equal(ended, false)
  assert.equal(typeof heartbeat, 'function')
  req.owner = null
  heartbeat()
  assert.equal(ended, true)
  assert.deepEqual(writes, [': connected\n\n'])
})
test('a revoked session cannot receive later notifications before its auth timer fires', async t => {
  const { service, store } = setup(t)
  service.start()
  const req = { method: 'GET', url: '/api/integrations/sparkygym/notifications', headers: {}, owner: { id: 'owner' } }
  const res = new EventEmitter()
  const writes = []; let ended = false
  Object.assign(res, { writeHead() {}, write(value) { writes.push(value); return true }, end() { ended = true; this.emit('close') } })
  await service.handle(req, res)
  req.owner = null
  store.markConflict('owner', id, 'source_rewind')
  service.afterCommitWake()
  assert.equal(ended, true)
  assert.deepEqual(writes, [': connected\n\n'])
})
test('accept requires exact signed claim binding, then rejects stale clients and isolates owners', async t => {
  const { service, store } = setup(t), keys = derivePairKeys(Buffer.alloc(32, 3).toString('base64url'), binding)
  store.createConnection('owner', { id, peer_origin: binding.sf_origin, peer_user_id: binding.sf_owner_ref, scopes: binding.scopes })
  store.prepareConnection('owner', id, binding, sealCredentials('persistent', id, { version: 1, sf_nonce: binding.sf_nonce, og_nonce: binding.og_nonce, incoming_key: keys.incoming.toString('base64url'), outgoing_key: keys.outgoing.toString('base64url') }))
  const body = Buffer.from(JSON.stringify(binding)), timestamp = String(Math.floor(Date.now() / 1000)), path = '/api/integrations/v1/pair/accept'
  const headers = { 'x-sparkygym-request-id': id, 'x-sparkygym-key-id': id + '_sf', 'x-sparkygym-timestamp': timestamp, 'x-sparkygym-signature': signControl('POST', path, body, id + '_sf', timestamp, keys.incoming, id) }
  assert.equal((await request(service, 'POST', path, body, null, headers)).status, 200)
  assert.equal((await request(service, 'POST', path, body, null, headers)).status, 200)
  assert.throws(() => service.beforeProfileWrite('owner', {}, {}), /client_upgrade_required/)
  assert.throws(() => service.beforeProfileWrite('owner', { bodyweight: [] }, { 'x-sparkygym-client-version': '1' }), /managed_body_fields/)
  assert.doesNotThrow(() => service.beforeProfileWrite('owner', { workouts: [] }, { 'x-sparkygym-client-version': '1' }))
  const status = (await request(service, 'GET', '/api/integrations/sparkygym', null, { id: 'owner' })).json
  assert.equal(status.connections[0].affected_record_counts.schedule_summary, 0)
  assert.equal(status.connections[0].peer_owner_ref, 'sf-owner')
  assert.equal(status.connections[0].delivery.pending > 0, true)
  assert.equal(status.connections[0].delivery.failed, 0)
  assert.equal(status.connections[0].delivery.last_success_at, null)
  assert.equal(JSON.stringify(status).includes('sealed_keys'), false)
  assert.equal((await request(service, 'POST', '/api/integrations/sparkygym/' + id + '/revoke', Buffer.from('{}'), { id: 'other' })).status, 404)
})
test('lost revoke ACK retries survive credential retirement and simultaneous local revoke is satisfied', async t => {
  const { service, store } = setup(t), keys = derivePairKeys(Buffer.alloc(32, 3).toString('base64url'), binding)
  store.createConnection('owner', { id, peer_origin: binding.sf_origin, peer_user_id: binding.sf_owner_ref, scopes: binding.scopes })
  const sealed = sealCredentials('persistent', id, { version: 1, sf_nonce: binding.sf_nonce, og_nonce: binding.og_nonce, incoming_key: keys.incoming.toString('base64url'), outgoing_key: keys.outgoing.toString('base64url') })
  store.prepareConnection('owner', id, binding, sealed); store.activateConnection('owner', id, sealed)
  assert.equal((await request(service, 'POST', '/api/integrations/sparkygym/' + id + '/revoke', Buffer.from('{}'), { id: 'owner' })).status, 200)
  const requestId = '33333333-3333-4333-8333-333333333333', bytes = Buffer.from(JSON.stringify({ version: 1, connection_id: id })), timestamp = String(Math.floor(Date.now() / 1000)), path = '/api/integrations/v1/revoke'
  const headers = { 'x-sparkygym-request-id': requestId, 'x-sparkygym-key-id': id + '_sf', 'x-sparkygym-timestamp': timestamp, 'x-sparkygym-signature': signControl('POST', path, bytes, id + '_sf', timestamp, keys.incoming, requestId) }
  assert.equal((await request(service, 'POST', path, bytes, null, headers)).status, 200)
  const retired = openCredentials('persistent', id, store.getConnection('owner', id).sealed_keys)
  assert.equal(retired.incoming_key, undefined)
  assert.equal(retired.outgoing_key, undefined)
  assert.equal(retired.revocation_receipt.request_id, requestId)
  assert.equal(store.pendingControls().some(job => job.path === path), false)
  await service.stop()
  const restarted = createSparkyGymIntegration({ store, secret: 'persistent', origin: 'https://og.example', readOwner: req => req.owner, csrfOk: () => true })
  t.after(() => restarted.stop())
  const retry = await request(restarted, 'POST', path, bytes, null, headers)
  assert.equal(retry.status, 200)
  assert.equal(verifyResponse(requestId, retry.status, Buffer.from(retry.body), retry.headers['X-SparkyGym-Key-Id'], retry.headers['X-SparkyGym-Timestamp'], retry.headers['X-SparkyGym-Signature'], keys.outgoing), true)
  const changed = Buffer.concat([bytes, Buffer.from(' ')])
  assert.equal((await request(restarted, 'POST', path, changed, null, { ...headers, 'x-sparkygym-signature': signControl('POST', path, changed, id + '_sf', timestamp, keys.incoming, requestId) })).status, 401)
  assert.equal((await request(restarted, 'GET', '/api/integrations/v1/capabilities', null, null, headers)).status, 401)
})
