import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openIntegrationStore } from '../storage/integration-store.js'
import { exportNativeEntities, normalizeTrainingIdentities, trainingChanges } from '../integrations/sparkygym-export.js'
const id = '22222222-2222-4222-8222-222222222222'
test('native progress GIF photos retain hash identity across date corrections and deletions', () => {
  const hash = 'b'.repeat(64), media = { hash, size: 20, mime: 'image/gif' }
  const first = { dayPhotos: { [hash]: { d: '2026-10-29', m: media, _ts: 1 } } }
  const entity = [...exportNativeEntities(first).values()][0]
  assert.equal(entity.payload.kind, 'progress')
  assert.equal(entity.payload.workout_id, null)
  assert.equal(entity.payload.sha256, hash)
  const corrected = { dayPhotos: { [hash]: { d: '2026-10-28', m: media, _ts: 2 } } }
  const changes = trainingChanges(first, corrected)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].entity_id, entity.entity_id)
  assert.equal(changes[0].payload.date, '2026-10-28')
  assert.equal(trainingChanges(corrected, { dayPhotos: { [hash]: { _ts: 3 } } })[0].operation, 'delete')
  assert.equal(exportNativeEntities({ customEx: [{ id: 'own', n: 'Own', media }] }).has('personal_media\n' + entity.entity_id), false)
})
test('URL notes survive snapshots while official media fields stay excluded', () => {
  const state = normalizeTrainingIdentities({ workouts: [{ id: 'url-note', d: '2026-10-29', note: 'https://example.com/personal-note', imageUrl: 'https://example.com/catalogue.jpg', entries: [] }] })
  const payload = exportNativeEntities(state).get('workout\nurl-note').payload
  assert.equal(payload.source_snapshot.note, state.workouts[0].note)
  assert.equal(payload.source_snapshot.imageUrl, undefined)
})
test('native routine assignments never export SF-owned weekly intent or mutate assignments', () => {
  const week = { 1: ['strength', 'mobility'], 2: 'strength' }
  const state = normalizeTrainingIdentities({ week, routines: [{ id: 'strength', name: 'Strength' }, { id: 'mobility', name: 'Mobility' }] })
  const failures = []
  assert.equal([...exportNativeEntities(state, failures).values()].some(entity => entity.resource === 'schedule_summary'), false)
  assert.deepEqual(state.week, week)
  assert.deepEqual(failures, [])
})
test('accepted workouts enqueue in the same commit, preserve intrinsic IDs across reorder and canonical units', t => {
  const store = openIntegrationStore(':memory:'); t.after(() => store.close())
  store.commitProfile('owner', 0, { workouts: [] })
  store.createConnection('owner', { id, peer_origin: 'https://sf.example', peer_user_id: 'sf', scopes: ['exercise', 'workout'] })
  store.prepareConnection('owner', id, { version: 1 }, { ciphertext: 'sealed', iv: 'iv', tag: 'tag' })
  store.activateConnection('owner', id, { ciphertext: 'sealed', iv: 'iv', tag: 'tag' })
  while (store.pendingControls().length) for (const job of store.pendingControls()) store.finishControl(job.request_id, 'delivered')
  const state = { unit: 'lb', workouts: [{ id: 'w1', name: 'Training', d: '2026-10-29', start: 1793250000000, end: 1793251800000, entries: [{ id: 'bench', sets: [{ w: 100, r: 5, done: true, at: 10 }, { w: 90, r: 8, done: true, at: 20 }] }] }] }
  store.commitProfile('owner', 1, state)
  const saved = store.getProfile('owner')
  assert.ok(saved.state.workouts[0].entries[0].instance_id)
  const sets = saved.state.workouts[0].entries[0].sets
  assert.ok(sets[0].set_id); assert.notEqual(sets[0].set_id, sets[1].set_id)
  const emitted = []
  while (store.pending('owner').length) for (const row of store.pending('owner')) {
    const value = JSON.parse(row.body); emitted.push(value)
    store.acknowledge('owner', value.event_id, { version: 1, event_id: value.event_id, status: 'applied', revision: value.revision })
  }
  const event = emitted.find(row => row.resource === 'workout')
  assert.equal(event.payload.exercises[0].sets[0].weight_kg, 45.359237)
  assert.equal(event.payload.calories_kcal, null)
  assert.equal(event.payload.exercises[0].sets[0].set_id, sets[0].set_id)
  assert.equal(event.payload.source_snapshot.version, 1)
  assert.ok(event.source_cursor > 0)
  const movedSetId = sets[1].set_id
  saved.state.workouts[0].entries[0].sets.reverse()
  store.commitProfile('owner', saved.revision, saved.state)
  assert.equal(store.getProfile('owner').state.workouts[0].entries[0].sets[0].set_id, movedSetId)
})
test('active ticks and AI drafts never emit; invalid exports are visible without rejecting native saves', t => {
  const store = openIntegrationStore(':memory:'); t.after(() => store.close())
  store.commitProfile('owner', 0, { workouts: [] })
  store.createConnection('owner', { id, peer_origin: 'https://sf.example', peer_user_id: 'sf', scopes: ['workout'] })
  store.prepareConnection('owner', id, { version: 1 }, { ciphertext: 'sealed', iv: 'iv', tag: 'tag' })
  store.activateConnection('owner', id, { ciphertext: 'sealed', iv: 'iv', tag: 'tag' })
  while (store.pendingControls().length) for (const job of store.pendingControls()) store.finishControl(job.request_id, 'delivered')
  store.commitProfile('owner', 1, { workouts: [], active: { tick: 1 }, aiDraft: { workouts: [] } })
  assert.deepEqual(store.pending('owner'), [])
  store.commitProfile('owner', 2, { workouts: [{ id: 'bad', d: 'not-a-day', entries: [] }] })
  assert.equal(store.getRevision('owner'), 3)
  assert.equal(store.deliveryStatus('owner', id).failed, 1)
  assert.equal(store.deliveryStatus('owner', id).last_error_code, 'invalid_domain_payload')
  assert.deepEqual(store.pending('owner'), [])
  store.commitProfile('owner', 3, { workouts: [{ id: 'bad', d: '2026-10-29', entries: [] }] })
  assert.equal(store.deliveryStatus('owner', id).failed, 0)
  assert.equal(store.pending('owner').length, 1)
})
