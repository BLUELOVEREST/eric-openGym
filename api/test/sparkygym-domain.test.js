import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { validateDomainPayload, parseDomainEvent } from '../integrations/sparkygym-domain.js'
import { exportNativeEntities, normalizeTrainingIdentities } from '../integrations/sparkygym-export.js'
test('opaque IDs, JSON keys and text reject lone surrogates but preserve valid Unicode pairs', () => {
  const payload = { exercise_id: 'valid', name: 'Valid', category: 'other', equipment: [], primary_muscles: [], secondary_muscles: [], aliases: [], notes: '\ud83d\ude00 https://example.com' }
  assert.doesNotThrow(() => validateDomainPayload('exercise', payload))
  for (const bad of ['\ud800', '\udfff']) {
    assert.throws(() => validateDomainPayload('exercise', { ...payload, exercise_id: bad }))
    assert.throws(() => validateDomainPayload('exercise', { ...payload, notes: bad }))
    const event = { version: 1, event_id: randomUUID(), connection_id: randomUUID(), producer: 'sparkyfitness', resource: 'body_goal', entity_id: bad, revision: 1, source_cursor: 1, operation: 'delete', occurred_at: '2026-10-29T00:00:00.000Z', payload: null }
    assert.throws(() => parseDomainEvent(Buffer.from(JSON.stringify(event))))
    const workout = [...exportNativeEntities(normalizeTrainingIdentities({ workouts: [{ id: 'w', d: '2026-10-29', entries: [] }] })).values()].find(value => value.resource === 'workout').payload
    assert.throws(() => validateDomainPayload('workout', { ...workout, source_snapshot: { version: 1, [bad]: 'text' } }))
    assert.throws(() => validateDomainPayload('workout', { ...workout, source_snapshot: { version: 1, note: bad } }))
  }
})
test('generic unitless body numbers may be negative, physical quantities may not', () => {
  const payload = { metric_id: 'custom:22222222-2222-4222-8222-222222222222', date: '2026-10-29', value: -3.5, unit: 'none', measured_at: null, timezone: 'UTC', definition: { label: 'Balance', value_type: 'number', builtin: false } }
  assert.doesNotThrow(() => validateDomainPayload('body_measurement', payload))
  assert.throws(() => validateDomainPayload('body_measurement', { ...payload, unit: 'kg', definition: { ...payload.definition, value_type: 'mass' } }))
})
test('all seven domain resources reject unknown payload fields independently of envelope fixtures', () => {
  const state = normalizeTrainingIdentities({ week: { 1: ['r'] }, routines: [{ id: 'r', name: 'Training' }], workouts: [{ id: 'w', d: '2026-10-29', name: 'Training', entries: [{ id: 'press', sets: [{ r: 5, w: 50, done: true }] }], media: [{ hash: 'a'.repeat(64), size: 123, mime: 'image/jpeg' }] }] })
  const payloads = Object.fromEntries([...exportNativeEntities(state).values()].map(entity => [entity.resource, entity.payload]))
  Object.assign(payloads, {
    schedule_summary: { name: 'Weekly intent', timezone: 'UTC', week_start: 1, effective_from: '2026-10-29', effective_until: null, days: [{ weekday: 1, slots: [{ time_slot: 'morning', activity: 'Training', is_main: true }] }] },
    body_definition: { metric_id: 'waist', label: 'Waist', value_type: 'length', unit: 'cm', builtin: true, enabled: true },
    body_measurement: { metric_id: 'waist', date: '2026-10-29', value: 80, unit: 'cm', measured_at: null, timezone: 'UTC', definition: { label: 'Waist', value_type: 'length', builtin: true } },
    body_goal: { metric_id: 'target_weight', value: 75, unit: 'kg', effective_date: null },
  })
  assert.equal(Object.keys(payloads).length, 7)
  for (const [resource, payload] of Object.entries(payloads)) {
    assert.doesNotThrow(() => validateDomainPayload(resource, payload), resource)
    assert.throws(() => validateDomainPayload(resource, { ...payload, extra: true }), TypeError, resource)
  }
  const event = { version: 1, event_id: randomUUID(), connection_id: randomUUID(), producer: 'sparkyfitness', resource: 'body_goal', entity_id: 'target_weight', revision: 1, operation: 'upsert', occurred_at: '2026-10-29T00:00:00.000Z', payload: payloads.body_goal }
  assert.throws(() => parseDomainEvent(Buffer.from(JSON.stringify(event))), /source_cursor_required/)
  assert.equal(parseDomainEvent(Buffer.from(JSON.stringify({ ...event, source_cursor: 1 }))).source_cursor, 1)
})
