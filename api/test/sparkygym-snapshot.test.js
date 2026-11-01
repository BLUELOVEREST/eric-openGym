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
  assert.throws(() => s.queueNativeSnapshot('o', id, true), /snapshot_in_progress/)
  s.finishControl(begin.request_id, 'delivered')
  s.finishControl(s.pendingControls()[0].request_id, 'delivered')
  const second = s.queueNativeSnapshot('o', id, true)
  const next = s.pendingControls().find(job => JSON.parse(job.body).snapshot_id === second.snapshot_id)
  assert.ok(JSON.parse(next.body).start_cursor > packet.watermark)
  assert.equal(s.pendingControls().length, 1)
})
test('activation authorizes history without automatically requesting or exporting it', t => {
  const s = openIntegrationStore(':memory:'); t.after(() => s.close())
  s.commitProfile('o', 0, {})
  const sealed = { ciphertext: 's', iv: 'i', tag: 't' }
  s.createConnection('o', { id, peer_origin: 'https://sf.example', peer_user_id: 'sf', scopes: ['workout'] })
  s.prepareConnection('o', id, { include_history: true }, sealed)
  s.activateConnection('o', id, sealed)
  const packets = []
  while (s.pendingControls().length) for (const job of s.pendingControls()) {
    if (job.path.endsWith('/snapshot')) packets.push(JSON.parse(job.body))
    s.finishControl(job.request_id, 'delivered')
  }
  assert.equal(packets.find(p => p.action === 'request').include_history, false)
  assert.deepEqual(packets.find(p => p.action === 'begin').prune_resources, [])
})
test('existing workout/media history is exported only by the explicit full action', t => {
  const s = openIntegrationStore(':memory:'); t.after(() => s.close())
  s.commitProfile('o', 0, { workouts: [{ id: 'old', d: '2026-10-20', entries: [], media: [{ hash: 'a'.repeat(64), size: 8, mime: 'image/jpeg', caption: '' }] }] })
  const sealed = { ciphertext: 's', iv: 'i', tag: 't' }
  s.createConnection('o', { id, peer_origin: 'https://sf.example', peer_user_id: 'sf', scopes: ['exercise', 'workout', 'personal_media'] })
  s.prepareConnection('o', id, { include_history: true }, sealed)
  s.activateConnection('o', id, sealed)
  const drain = () => {
    const events = []
    while (s.pendingControls().length || s.pending('o').length) {
      for (const job of s.pendingControls()) s.finishControl(job.request_id, 'delivered')
      for (const job of s.pending('o')) {
        const event = JSON.parse(job.body); events.push(event)
        s.acknowledge('o', event.event_id, { version: 1, event_id: event.event_id, revision: event.revision, status: 'applied' })
      }
    }
    return events
  }
  assert.deepEqual(drain().filter(event => ['workout', 'personal_media'].includes(event.resource)), [])
  assert.deepEqual(s.pendingMedia(), [])
  s.queueTwoWaySnapshot('o', id, true)
  assert.deepEqual(drain().map(event => event.resource).sort(), ['personal_media', 'workout'])
  assert.equal(s.pendingMedia().length, 1)
})
test('owner full queues reject pending snapshot controls, including delayed jobs, without queue growth', t => {
  const s = setup(t, true)
  s.queueTwoWaySnapshot('o', id, true)
  const first = s.pendingControls()[0]
  s.finishControl(first.request_id, 'pending', Date.now() + 60000, 'control_delivery_failed')
  const before = s.pendingControls(Number.MAX_SAFE_INTEGER)
  for (const method of ['queueTwoWaySnapshot', 'queueNativeSnapshot']) {
    assert.throws(() => s[method]('o', id, true), /snapshot_in_progress/)
    assert.deepEqual(s.pendingControls(Number.MAX_SAFE_INTEGER), before)
  }
})
test('an open incoming snapshot prevents full export until completion', t => {
  const s = setup(t, true), snapshot = randomUUID()
  s.beginIncomingSnapshot('o', id, { version: 1, action: 'begin', connection_id: id, snapshot_id: snapshot, start_cursor: 1, watermark: 1, expected_count: 0, membership_sha256: createHash('sha256').update('').digest('hex'), prune_resources: ['body_measurement'] })
  for (const method of ['queueTwoWaySnapshot', 'queueNativeSnapshot']) assert.throws(() => s[method]('o', id, true), /snapshot_in_progress/)
  s.completeIncomingSnapshot('o', id, snapshot)
  assert.equal(s.queueTwoWaySnapshot('o', id, true).status, 'snapshot_queued')
})
test('only one incoming snapshot can be open; exact begin replay remains idempotent', t => {
  const s = setup(t, true)
  const begin = { version: 1, action: 'begin', connection_id: id, snapshot_id: randomUUID(), start_cursor: 1, watermark: 1, expected_count: 0, membership_sha256: createHash('sha256').update('').digest('hex'), prune_resources: ['body_measurement'] }
  s.beginIncomingSnapshot('o', id, begin)
  assert.doesNotThrow(() => s.beginIncomingSnapshot('o', id, begin))
  assert.throws(() => s.beginIncomingSnapshot('o', id, { ...begin, snapshot_id: randomUUID() }), /snapshot_in_progress/)
})
test('peer full requests coalesce after begin delivery and queue safely behind current initialization', t => {
  const s = setup(t, true)
  const current = s.queueNativeSnapshot('o', id, false)
  const full = s.queueNativeSnapshot('o', id, true, true)
  assert.notEqual(full.snapshot_id, current.snapshot_id)
  assert.deepEqual(s.queueNativeSnapshot('o', id, true, true), full)
  while (s.pendingControls().length) {
    const job = s.pendingControls()[0], packet = JSON.parse(job.body)
    s.finishControl(job.request_id, 'delivered')
    if (packet.action === 'begin' && packet.snapshot_id === full.snapshot_id) break
  }
  assert.deepEqual(s.queueNativeSnapshot('o', id, true, true), full)
  assert.equal(s.pendingControls().length, 1)
})
test('repeated full history preserves source/entity identity, duplicate and stale snapshot membership', t => {
  const s = setup(t, true)
  const original = measurement('weight', 1)
  assert.equal(s.receiveBody('o', original).status, 'applied')
  assert.equal(s.receiveBody('o', original).status, 'duplicate')
  const next = JSON.parse(measurement('weight', 2)); next.revision = 2; next.payload.value = 79
  const begin = { version: 1, action: 'begin', connection_id: id, snapshot_id: randomUUID(), start_cursor: 2, watermark: 3, expected_count: 1, membership_sha256: createHash('sha256').update('body_measurement\0weight\n').digest('hex'), prune_resources: ['body_measurement'] }
  s.beginIncomingSnapshot('o', id, begin)
  assert.equal(s.receiveBody('o', Buffer.from(JSON.stringify(next))).status, 'applied')
  assert.equal(s.receiveBody('o', Buffer.from(JSON.stringify(next))).status, 'duplicate')
  assert.equal(s.receiveBody('o', measurement('weight', 3)).status, 'stale')
  s.completeIncomingSnapshot('o', id, begin.snapshot_id)
  const body = s.getBodyProfile('o')
  assert.equal(body.measurements.length, 1)
  assert.equal(body.measurements[0].value, 79)
  assert.doesNotThrow(() => s.completeIncomingSnapshot('o', id, begin.snapshot_id))
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
