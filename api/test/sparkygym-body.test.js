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
  assert.equal(state.measurements[0].upperArmLeft, 32)
  assert.deepEqual(stripManagedBodyFields({ ...state, targetW: 72 }), { workouts: [] })
})

test('all eighteen SF built-in circumferences use native fields, not Other', () => {
  const fields = { neck: 'neck', shoulders: 'shoulders', chest: 'chest', waist: 'waist', hips: 'hips', abdomen: 'abdomen', left_biceps: 'upperArmLeft', right_biceps: 'upperArmRight', left_forearm: 'forearmLeft', right_forearm: 'forearmRight', left_wrist: 'wristLeft', right_wrist: 'wristRight', left_thigh: 'thighLeft', right_thigh: 'thighRight', left_calf: 'calfLeft', right_calf: 'calfRight', left_ankle: 'ankleLeft', right_ankle: 'ankleRight' }
  const measurements = Object.keys(fields).map((metric, index) => ({ ...payload(metric, index + 20), entity_id: '2026-10-31:' + metric, date: '2026-10-31' }))
  const definitions = measurements.map(m => ({ metric_id: m.metric_id, ...m.definition, unit: m.unit, enabled: true }))
  const state = composeBodyState({ workouts: [] }, { managed: true, definitions, measurements, target: null })
  assert.equal(state.measurements.length, 1)
  for (const [index, field] of Object.values(fields).entries()) assert.equal(state.measurements[0][field], index + 20, field)
  assert.deepEqual(state.measurements[0].other, [])
  assert.deepEqual(state.customMeasurements, [])
})

test('circumference aliases do not reinterpret custom definitions or incompatible units', () => {
  const custom = { ...payload('left_forearm', 7), entity_id: 'custom', definition: { builtin: false, label: 'My measure', value_type: 'length' } }
  const mass = { ...payload('left_wrist', 2, 'kg'), entity_id: 'mass' }
  const canonical = { ...payload('upper_arm_right', 33), entity_id: 'canonical' }
  const state = composeBodyState({}, { managed: true, definitions: [], measurements: [custom, mass, canonical], target: null })
  assert.equal(state.measurements[0].forearmLeft, undefined)
  assert.equal(state.measurements[0].wristLeft, undefined)
  assert.equal(state.measurements[0].upperArmRight, 33)
  assert.equal(state.measurements[0].other.length, 2)
})

test('unknown built-in metric IDs cannot resolve inherited object members as native fields', () => {
  const reading = { ...payload('constructor', 7), entity_id: 'unknown' }
  const state = composeBodyState({}, { managed: true, definitions: [], measurements: [reading], target: null })
  assert.equal(state.measurements[0].other[0].id, 'constructor')
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
