import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openIntegrationStore } from '../storage/integration-store.js'
import { parseDomainEvent, validateDomainPayload } from '../integrations/sparkygym-domain.js'
import { membershipHash } from '../integrations/sparkygym-snapshot.js'
const payload = () => ({ name: 'Next week', timezone: 'Asia/Shanghai', week_start: 1, effective_from: '2026-11-02', effective_until: '2026-11-08', days: [{ weekday: 1, slots: [{ time_slot: 'morning', activity: 'Chest', is_main: false }, { time_slot: 'evening', activity: 'Football', is_main: true }] }, { weekday: 2, slots: [] }] })
const event = (id, cursor, extra = {}) => Buffer.from(JSON.stringify({ version: 1, event_id: randomUUID(), connection_id: id, producer: 'sparkyfitness', resource: 'schedule_summary', entity_id: '42', revision: cursor, source_cursor: cursor, operation: 'upsert', occurred_at: '2026-10-30T00:00:00.000Z', payload: payload(), ...extra }))
function setup(t, scopes = ['schedule_summary'], owner = 'owner') {
  const store = openIntegrationStore(':memory:'); t.after(() => store.close())
  const id = randomUUID(), state = { dayNotes: { '2026-11-02': { text: 'Private note', tag: 'sick' } }, week: { 1: ['r'] }, routines: [{ id: 'r', ex: [] }], workouts: [] }
  store.commitProfile(owner, 0, state)
  store.createConnection(owner, { id, peer_origin: 'https://sf.example', peer_user_id: 'sf-owner', scopes })
  store.activateConnection(owner, id, { ciphertext: 's', iv: 'i', tag: 't' })
  return { store, id, state, owner }
}
test('bucket payload and SF-only producer are independent strict wire contracts', () => {
  const raw = event(randomUUID(), 1)
  assert.doesNotThrow(() => parseDomainEvent(raw))
  assert.throws(() => parseDomainEvent(Buffer.from(raw.toString().replace('"sparkyfitness"', '"opengym"'))))
  for (const slots of [
    [{ time_slot: 'morning', activity: 'Chest', is_main: false }],
    [{ time_slot: 'morning', activity: 'Chest', is_main: true }, { time_slot: 'morning', activity: 'Football', is_main: false }],
    [{ slot_id: 'old', time_of_day: '08:00', activity: 'Chest', is_main: true }],
  ]) assert.throws(() => validateDomainPayload('schedule_summary', { ...payload(), days: [{ weekday: 1, slots }] }))
})
test('wire text preserves nonempty code units without imposing UI whitespace policy', () => {
  const value = payload()
  value.name = ' '
  value.days[0].slots[0].activity = '\t'
  assert.equal(validateDomainPayload('schedule_summary', value), value)
  for (const name of ['', 'x'.repeat(301), '\ud800']) {
    assert.throws(() => validateDomainPayload('schedule_summary', { ...value, name }))
  }
})
test('schedule-only receiver serves dated hints while leaving profile, ownership and private notes untouched', t => {
  const { store, id, state } = setup(t)
  const revision = store.getRevision('owner'), raw = event(id, 1)
  store.receiveIncoming('owner', raw)
  assert.deepEqual(store.getTrainingHints('owner', '2026-11-02').hints, [{ entity_id: '42', ...payload() }])
  assert.equal(store.getTrainingHints('owner', '2026-11-04').hints.length, 1)
  assert.deepEqual(store.getTrainingHints('owner'), { revision: 1, date: null, hints: [{ entity_id: '42', ...payload() }] })
  assert.deepEqual(store.getTrainingHints('owner', '2026-11-01').hints, [])
  assert.deepEqual(store.getTrainingHints('owner', '2026-11-09').hints, [])
  assert.deepEqual(store.getTrainingHints('another', '2026-11-02').hints, [])
  assert.deepEqual(store.getProfile('owner').state, state)
  assert.equal(store.getRevision('owner'), revision)
  assert.equal(store.getBodyProfile('owner').managed, false)
  assert.equal(store.receiveIncoming('owner', raw).status, 'duplicate')
  assert.throws(() => store.getTrainingHints('owner', '2026-02-30'), /invalid_date/)
})
test('body and hints share a single incoming cursor and snapshot membership boundary', t => {
  const { store, id } = setup(t, ['schedule_summary', 'body_measurement'])
  store.receiveIncoming('owner', event(id, 2))
  const measurement = { metric_id: 'weight', date: '2026-10-30', value: 80, unit: 'kg', measured_at: null, timezone: 'UTC', definition: { label: 'Weight', value_type: 'mass', builtin: true } }
  assert.throws(() => store.receiveIncoming('owner', event(id, 1, { resource: 'body_measurement', entity_id: 'weight', payload: measurement })), /source_rewind/)
  store.receiveIncoming('owner', event(id, 3, { resource: 'body_measurement', entity_id: 'weight', payload: measurement }))
  assert.throws(() => store.receiveIncoming('owner', event(id, 2)), /source_rewind/)
  const snapshot = randomUUID()
  store.beginIncomingSnapshot('owner', id, { version: 1, action: 'begin', connection_id: id, snapshot_id: snapshot, start_cursor: 4, watermark: 4, expected_count: 0, membership_sha256: membershipHash([]), prune_resources: ['schedule_summary'] })
  store.completeIncomingSnapshot('owner', id, snapshot)
  assert.deepEqual(store.getTrainingHints('owner', '2026-11-02').hints, [])
  assert.equal(store.getBodyProfile('owner').measurements.length, 1)
  assert.throws(() => store.beginIncomingSnapshot('owner', id, { version: 1, action: 'begin', connection_id: id, snapshot_id: randomUUID(), start_cursor: 1, watermark: 1, expected_count: 0, membership_sha256: membershipHash([]), prune_resources: ['schedule_summary'] }), /source_rewind/)
})
test('scope denial and bad payloads roll back; revocation retains hints until explicit purge', t => {
  const { store, id } = setup(t)
  assert.throws(() => store.receiveIncoming('owner', event(id, 1, { payload: { ...payload(), name: '' } })))
  assert.equal(store.getTrainingHints('owner', '2026-11-02').revision, 0)
  store.receiveIncoming('owner', event(id, 1))
  store.revokeConnection('owner', id)
  assert.equal(store.getTrainingHints('owner', '2026-11-02').hints.length, 1)
  assert.throws(() => store.receiveIncoming('owner', event(id, 2)), /connection_inactive/)
  store.purgeBody('owner', id, true)
  assert.equal(store.getTrainingHints('owner', '2026-11-02').hints.length, 0)
  assert.doesNotThrow(() => store.purgeBody('owner', id, true))
})
test('a hint cannot enter a body-only scope or a second SF coordinating identity', t => {
  const { store, id } = setup(t, ['body_measurement'])
  assert.throws(() => store.receiveIncoming('owner', event(id, 1)), /scope/)
  const other = randomUUID()
  store.createConnection('owner', { id: other, peer_origin: 'https://other.example', peer_user_id: 'other-owner', scopes: ['schedule_summary'] })
  store.prepareConnection('owner', other, { include_history: true }, { ciphertext: 's', iv: 'i', tag: 't' })
  assert.throws(() => store.activateConnection('owner', other, { ciphertext: 's', iv: 'i', tag: 't' }), /body_source_exists/)
  assert.equal(store.getConnection('owner', other).status, 'pending')
  assert.equal(store.getConnection('owner', id).status, 'active')
})
test('hint snapshots retain declared members and preserve newer live updates', t => {
  const { store, id } = setup(t)
  store.receiveIncoming('owner', event(id, 1, { entity_id: 'removed' }))
  const snapshot = randomUUID(), member = event(id, 3)
  const entity = JSON.parse(member)
  store.beginIncomingSnapshot('owner', id, { version: 1, action: 'begin', connection_id: id, snapshot_id: snapshot, start_cursor: 2, watermark: 3, expected_count: 1, membership_sha256: membershipHash([entity]), prune_resources: ['schedule_summary'] })
  store.receiveIncoming('owner', member)
  store.receiveIncoming('owner', event(id, 4, { entity_id: 'new-live' }))
  store.completeIncomingSnapshot('owner', id, snapshot)
  assert.deepEqual(store.getTrainingHints('owner').hints.map(hint => hint.entity_id), ['42', 'new-live'])
  assert.equal(store.getBodyProfile('owner').managed, false)
})
test('schedule-only re-pair retains hint history and shared head until a confirmed replacement', t => {
  const { store, id } = setup(t)
  store.receiveIncoming('owner', event(id, 7))
  const next = randomUUID(), sealed = { ciphertext: 's', iv: 'i', tag: 't' }
  store.createConnection('owner', { id: next, peer_origin: 'https://sf.example', peer_user_id: 'sf-owner', scopes: ['schedule_summary'] })
  store.prepareConnection('owner', next, { include_history: true }, sealed)
  store.activateConnection('owner', next, sealed)
  assert.equal(store.getConnection('owner', id).status, 'revoked')
  assert.ok(store.getConnection('owner', id).sealed_keys)
  assert.equal(store.getTrainingHints('owner').hints.length, 1)
  assert.equal(store.getBodyProfile('owner').managed, false)
  assert.throws(() => store.receiveIncoming('owner', event(next, 6)), /source_rewind/)
  store.receiveIncoming('owner', event(next, 8))
  assert.throws(() => store.purgeBody('owner', id, true), /source_still_connected/)
  store.confirmReplacementSnapshot('owner', next, store.getConnection('owner', next).replacement_snapshot_id)
  assert.equal(store.getConnection('owner', id).sealed_keys, null)
})
test('purge retains each SF identity head across detach, another source, re-pair and both incoming domains', t => {
  const { store, id } = setup(t, ['schedule_summary', 'body_measurement'])
  const sealed = { ciphertext: 's', iv: 'i', tag: 't' }
  store.receiveIncoming('owner', event(id, 50))
  store.revokeConnection('owner', id)
  store.purgeBody('owner', id, true)
  assert.deepEqual(store.getTrainingHints('owner').hints, [])
  assert.equal(store.getBodyProfile('owner').managed, false)
  const other = randomUUID()
  store.createConnection('owner', { id: other, peer_origin: 'https://different.example', peer_user_id: 'different-owner', scopes: ['schedule_summary'] })
  store.activateConnection('owner', other, sealed)
  store.receiveIncoming('owner', event(other, 100))
  store.revokeConnection('owner', other)
  store.purgeBody('owner', other, true)
  const next = randomUUID()
  store.createConnection('owner', { id: next, peer_origin: 'https://sf.example', peer_user_id: 'sf-owner', scopes: ['schedule_summary', 'body_measurement'] })
  store.activateConnection('owner', next, sealed)
  assert.throws(() => store.receiveIncoming('owner', event(next, 49)), /source_rewind/)
  const measurement = { metric_id: 'weight', date: '2026-10-30', value: 80, unit: 'kg', measured_at: null, timezone: 'UTC', definition: { label: 'Weight', value_type: 'mass', builtin: true } }
  assert.throws(() => store.receiveIncoming('owner', event(next, 50, { resource: 'body_measurement', payload: measurement })), /source_rewind/)
  assert.throws(() => store.beginIncomingSnapshot('owner', next, { version: 1, action: 'begin', connection_id: next, snapshot_id: randomUUID(), start_cursor: 49, watermark: 49, expected_count: 0, membership_sha256: membershipHash([]), prune_resources: ['schedule_summary'] }), /source_rewind/)
  store.receiveIncoming('owner', event(next, 51, { resource: 'body_measurement', payload: measurement }))
  assert.throws(() => store.receiveIncoming('owner', event(next, 50)), /source_rewind/)
  store.receiveIncoming('owner', event(next, 52))
  assert.equal(store.getTrainingHints('owner').hints.length, 1)
})
test('schema 10 migration preserves the source head, body history and profile without a cursor mirror', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-hint-migration-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filename = path.join(dir, 'profiles.sqlite'), id = randomUUID()
  const prior = openIntegrationStore(filename)
  prior.commitProfile('owner', 0, { workouts: [], dayNotes: { '2026-10-30': { text: 'Private' } } })
  prior.createConnection('owner', { id, peer_origin: 'https://sf.example', peer_user_id: 'sf-owner', scopes: ['body_measurement', 'schedule_summary'] })
  prior.activateConnection('owner', id, { ciphertext: 's', iv: 'i', tag: 't' })
  prior.receiveIncoming('owner', event(id, 9, { resource: 'body_measurement', entity_id: 'weight', payload: { metric_id: 'weight', date: '2026-10-30', value: 80, unit: 'kg', measured_at: null, timezone: 'UTC', definition: { label: 'Weight', value_type: 'mass', builtin: true } } }))
  const profile = prior.getProfile('owner'), body = prior.getBodyProfile('owner')
  prior.close()
  // Recreate the published schema-10 layout, with its existing source head.
  const db = new DatabaseSync(filename)
  db.exec(`ALTER TABLE body_sources ADD COLUMN source_cursor INTEGER NOT NULL DEFAULT 0;
    UPDATE body_sources SET source_cursor=(SELECT source_cursor FROM incoming_sources WHERE incoming_sources.owner_id=body_sources.owner_id);
    DROP TABLE incoming_sources; DROP TABLE training_hints; DROP TABLE training_hint_revisions;
    ALTER TABLE incoming_snapshots RENAME TO body_snapshots;
    ALTER TABLE incoming_snapshot_members RENAME TO body_snapshot_members;
    PRAGMA user_version=10;`)
  db.close()
  const next = openIntegrationStore(filename)
  try {
    assert.deepEqual(next.getProfile('owner'), profile)
    assert.deepEqual(next.getBodyProfile('owner'), body)
    assert.throws(() => next.receiveIncoming('owner', event(id, 8)), /source_rewind/)
    next.receiveIncoming('owner', event(id, 10))
    assert.equal(next.getTrainingHints('owner').hints.length, 1)
  } finally { next.close() }
  const inspect = new DatabaseSync(filename, { readOnly: true })
  try {
    assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 12)
    assert.equal(inspect.prepare('SELECT source_cursor FROM incoming_sources').get().source_cursor, 10)
    assert.equal(inspect.prepare('PRAGMA table_info(body_sources)').all().some(column => column.name === 'source_cursor'), false)
    assert.deepEqual(inspect.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { inspect.close() }
  const v11 = new DatabaseSync(filename)
  v11.exec(`ALTER TABLE incoming_sources RENAME TO source_heads_v12;
    CREATE TABLE incoming_sources(owner_id TEXT PRIMARY KEY REFERENCES profiles(owner_id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES connections(id),source_id TEXT NOT NULL,source_cursor INTEGER NOT NULL DEFAULT 0) STRICT;
    INSERT INTO incoming_sources SELECT owner_id,connection_id,source_id,source_cursor FROM source_heads_v12;
    DROP TABLE source_heads_v12;
    PRAGMA user_version=11;`)
  v11.close()
  const upgraded = openIntegrationStore(filename)
  try {
    upgraded.revokeConnection('owner', id)
    upgraded.purgeBody('owner', id, true)
  } finally { upgraded.close() }
  const restarted = openIntegrationStore(filename)
  const replacement = randomUUID()
  try {
    restarted.createConnection('owner', { id: replacement, peer_origin: 'https://sf.example', peer_user_id: 'sf-owner', scopes: ['schedule_summary'] })
    restarted.activateConnection('owner', replacement, { ciphertext: 's', iv: 'i', tag: 't' })
    assert.throws(() => restarted.receiveIncoming('owner', event(replacement, 9)), /source_rewind/)
    restarted.receiveIncoming('owner', event(replacement, 11))
    restarted.deleteProfile('owner')
  } finally { restarted.close() }
  const deleted = new DatabaseSync(filename, { readOnly: true })
  try {
    assert.equal(deleted.prepare('SELECT COUNT(*) AS n FROM incoming_sources').get().n, 0)
    assert.deepEqual(deleted.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { deleted.close() }
})
