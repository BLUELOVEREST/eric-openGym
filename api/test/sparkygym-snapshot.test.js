import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { openIntegrationStore } from '../storage/integration-store.js'
const id = '22222222-2222-4222-8222-222222222222'
const measurement = (entity, cursor) => Buffer.from(JSON.stringify({ version: 1, event_id: randomUUID(), connection_id: id, producer: 'sparkyfitness', resource: 'body_measurement', entity_id: entity, revision: 1, source_cursor: cursor, operation: 'upsert', occurred_at: '2026-10-29T00:00:00.000Z', payload: { metric_id: 'weight', date: '2026-10-29', value: 80, unit: 'kg', measured_at: null, timezone: 'UTC', definition: { label: 'Weight', value_type: 'mass', builtin: true } } }))
function setup(t, includeHistory) {
  const store = openIntegrationStore(':memory:'); t.after(() => store.close())
  const sealed = { ciphertext: 's', iv: 'i', tag: 't' }
  store.commitProfile('o', 0, {})
  store.createConnection('o', { id, peer_origin: 'https://sf.example', peer_user_id: 'sf', scopes: ['body_measurement', 'workout'] })
  if (includeHistory !== undefined) store.prepareConnection('o', id, {
    version: 1, connection_id: id, sf_owner_ref: 'sf', og_owner_ref: 'o',
    sf_origin: 'https://sf.example', og_origin: 'https://og.example',
    sf_nonce: Buffer.alloc(32, 1).toString('base64url'), og_nonce: Buffer.alloc(32, 2).toString('base64url'),
    scopes: ['body_measurement', 'workout'], include_history: includeHistory,
  }, sealed)
  store.activateConnection('o', id, sealed)
  while (store.pendingControls().length) for (const job of store.pendingControls()) store.finishControl(job.request_id, 'delivered')
  return store
}
test('snapshot completion validates membership and cannot erase post-watermark events', t => {
  const s = setup(t), snapshot = randomUUID()
  s.receiveBody('o', measurement('old', 1))
  s.beginBodySnapshot('o', id, { version: 1, action: 'begin', connection_id: id, snapshot_id: snapshot, start_cursor: 2, watermark: 2, expected_count: 1, membership_sha256: createHash('sha256').update('body_measurement\0member\n').digest('hex'), prune_resources: ['body_measurement'] })
  assert.throws(() => s.completeBodySnapshot('o', id, snapshot), /snapshot_incomplete/)
  s.receiveBody('o', measurement('member', 2)); s.receiveBody('o', measurement('newer', 3))
  s.completeBodySnapshot('o', id, snapshot)
  assert.deepEqual(s.getBodyProfile('o').measurements.map(row => row.entity_id).sort(), ['member', 'newer'])
  assert.doesNotThrow(() => s.completeBodySnapshot('o', id, snapshot))
})
test('outgoing snapshot captures membership and immutable begin/items/complete in one transaction', t => {
  const s = setup(t, true)
  const snapshot = s.queueNativeSnapshot('o', id, true)
  assert.ok(snapshot.snapshot_id)
  assert.equal(snapshot.status, 'snapshot_queued')
  const begin = s.pendingControls()[0]
  assert.equal(JSON.parse(begin.body).action, 'begin')
  const packet = JSON.parse(begin.body)
  assert.ok(packet.start_cursor > 0)
  assert.ok(packet.watermark >= packet.start_cursor)
  const second = s.queueNativeSnapshot('o', id, true)
  s.finishControl(begin.request_id, 'delivered')
  s.finishControl(s.pendingControls()[0].request_id, 'delivered')
  const next = s.pendingControls().find(job => JSON.parse(job.body).snapshot_id === second.snapshot_id)
  assert.ok(JSON.parse(next.body).start_cursor > packet.watermark)
  assert.equal(s.pendingControls().length, 1)
})
for (const approval of [undefined, false]) {
  for (const method of ['queueNativeSnapshot', 'queueTwoWaySnapshot']) {
    test(`${method} denies history without explicit binding approval (${approval})`, t => {
      const s = setup(t, approval)
      const before = { profile: s.getProfile('o'), connection: s.getConnection('o', id), notifications: s.notifications('o', 0) }
      assert.throws(() => s[method]('o', id, true), /history_not_authorized/)
      assert.equal(s.pendingControls().length, 0)
      assert.equal(s.pending('o').length, 0)
      assert.deepEqual({ profile: s.getProfile('o'), connection: s.getConnection('o', id), notifications: s.notifications('o', 0) }, before)
      assert.equal(s[method]('o', id, false).status, 'snapshot_queued')
    })
  }
}
test('two-way history snapshot is allowed by explicit binding approval', t => {
  const s = setup(t, true)
  assert.equal(s.queueTwoWaySnapshot('o', id, true).status, 'snapshot_queued')
})
test('a no-history binding cannot prune historical measurements through an empty snapshot', t => {
  const s = setup(t, false)
  s.receiveBody('o', measurement('retained', 1))
  const before = s.getBodyProfile('o')
  assert.throws(() => s.beginIncomingSnapshot('o', id, { version: 1, action: 'begin', connection_id: id, snapshot_id: randomUUID(), start_cursor: 2, watermark: 2, expected_count: 0, membership_sha256: createHash('sha256').update('').digest('hex'), prune_resources: ['body_measurement'] }), /history_not_authorized/)
  assert.deepEqual(s.getBodyProfile('o'), before)
})
