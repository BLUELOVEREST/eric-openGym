import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openIntegrationStore } from '../storage/integration-store.js'
import { composeBodyState, stripManagedBodyFields } from '../integrations/sparkygym-body-model.js'

const connection = '22222222-2222-4222-8222-222222222222'
const payload = (metric_id, value, unit = 'cm') => ({ metric_id, date: '2026-10-29', value, unit, measured_at: null, timezone: 'UTC', definition: { label: metric_id, value_type: unit === 'kg' ? 'mass' : 'length', builtin: true } })
function setup(t) {
  const store = openIntegrationStore(':memory:'); t.after(() => store.close())
  store.commitProfile('owner', 0, { bodyweight: [{ d: '2026-10-28', w: 80 }], measurements: [], targetW: 75, workouts: [] })
  store.createConnection('owner', { id: connection, peer_origin: 'https://sf.example', peer_user_id: 'sf-owner', scopes: ['body_definition', 'body_measurement', 'body_goal', 'workout'] })
  store.activateConnection('owner', connection, { ciphertext: 'encrypted', iv: 'iv', tag: 'tag' })
  return store
}
let sourceCursor = 0
const event = (resource, entity_id, value, revision = 1) => Buffer.from(JSON.stringify({ version: 1, event_id: randomUUID(), connection_id: connection, producer: 'sparkyfitness', resource, entity_id, revision, source_cursor: ++sourceCursor, operation: value === null ? 'delete' : 'upsert', occurred_at: '2026-10-29T06:00:00.000Z', payload: value }))
test('activation archives local body fields and native body values preserve same-day partial metrics', t => {
  const store = setup(t)
  assert.equal('bodyweight' in store.getProfile('owner').state, false)
  assert.equal(store.getBodyArchive('owner').length, 1)
  store.receiveBody('owner', event('body_measurement', 'weight-1', payload('weight', 78, 'kg')))
  store.receiveBody('owner', event('body_measurement', 'biceps-left', payload('left_biceps', 32)))
  const body = store.getBodyProfile('owner')
  assert.equal(body.managed, true)
  assert.equal(body.measurements.length, 2)
  const state = composeBodyState({ workouts: [] }, body)
  assert.equal(state.bodyweight[0].w, 78)
  assert.equal(state.measurements[0].leftArm, undefined)
  assert.equal(state.measurements[0].sourceMetrics.left_biceps, 32)
  assert.deepEqual(stripManagedBodyFields({ ...state, targetW: 72 }), { workouts: [] })
})
test('all direct profile writes reject source-owned body fields, while reset retains projection', t => {
  const store = setup(t)
  store.receiveBody('owner', event('body_measurement', 'weight-1', payload('weight', 78, 'kg')))
  assert.throws(() => store.commitProfile('owner', store.getRevision('owner'), { workouts: [], bodyweight: [] }), /managed_body_fields/)
  store.commitProfile('owner', store.getRevision('owner'), { workouts: [] })
  assert.equal(store.getBodyProfile('owner').measurements.length, 1)
  store.revokeConnection('owner', connection)
  assert.equal(store.getBodyProfile('owner').managed, true)
  assert.throws(() => store.purgeBody('owner', connection, false), /confirmation_required/)
  store.purgeBody('owner', connection, true)
  assert.equal(store.getBodyProfile('owner').managed, false)
})
test('payload validation is transactional, historical snapshots survive definition changes and replay is durable', t => {
  const store = setup(t), bytes = event('body_measurement', 'weight-1', payload('weight', 78, 'kg'))
  assert.equal(store.receiveBody('owner', bytes).status, 'applied')
  assert.equal(store.receiveBody('owner', bytes).status, 'duplicate')
  assert.throws(() => store.receiveBody('owner', event('body_measurement', 'bad', { ...payload('weight', 78, 'kg'), date: '2026-02-30' })), /invalid_body_payload/)
  store.receiveBody('owner', event('body_definition', 'weight', { metric_id: 'weight', label: 'New label', value_type: 'mass', unit: 'kg', builtin: true, enabled: true }))
  assert.equal(store.getBodyProfile('owner').measurements[0].definition.label, 'weight')
  assert.equal(store.notifications('owner', 0).length, 2)
  assert.deepEqual(store.notifications('other', 0), [])
})
