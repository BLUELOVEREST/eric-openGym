import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { initializeProfileStorage } from '../storage/profile-migration.js'
import { openIntegrationStore } from '../storage/integration-store.js'

const users = [{ id: 'u_one' }, { id: 'u_two' }]
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-profile-import-'))
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }))
  const handles = []
  t.after(() => { for (const store of handles) store.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { dir, open() { const store = initializeProfileStorage(dir, { users }); handles.push(store); return store } }
}

test('one-time import preserves every profile and verifies a private backup before retirement', t => {
  const { dir, open } = fixture(t)
  const state = { _rev: 37, workouts: [{ id: 'w1', d: '2026-10-29' }], bw: [{ d: '2026-10-29', v: 75 }] }
  const bytes = Buffer.from(JSON.stringify(state))
  fs.writeFileSync(path.join(dir, 'state-u_one.json'), bytes)
  const authBefore = fs.readFileSync(path.join(dir, 'db.json'))
  const store = open()
  assert.deepEqual(store.getProfile('u_one').state, state)
  assert.equal(store.getProfile('u_two'), null)
  const marker = store.getProfileMigration()
  assert.equal(marker.version, 1)
  assert.equal(marker.archive_complete, true)
  const backup = path.join(dir, marker.backup_directory)
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700)
  assert.deepEqual(fs.readFileSync(path.join(backup, 'state-u_one.json')), bytes)
  assert.equal(fs.statSync(path.join(backup, 'state-u_one.json')).mode & 0o777, 0o600)
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'))
  assert.equal(manifest.files.find(row => row.name === 'state-u_one.json').sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(fs.existsSync(path.join(dir, 'state-u_one.json')), false)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'db.json')), authBefore)
})

test('a later startup never reimports or falls back to a regenerated legacy JSON file', t => {
  const { dir, open } = fixture(t)
  fs.writeFileSync(path.join(dir, 'state-u_one.json'), '{"workouts":[]}')
  const store = open()
  store.commitProfile('u_one', 1, { workouts: [{ id: 'sql-only' }] })
  fs.writeFileSync(path.join(dir, 'state-u_one.json'), 'not JSON and never a fallback')
  const next = open()
  assert.equal(next.getProfile('u_one').state.workouts[0].id, 'sql-only')
  assert.equal(next.getProfile('u_one').revision, 2)
})

test('bad JSON and invalid profile shapes leave all business rows unimported', t => {
  for (const bad of ['{broken', 'null', '[]', '{"value":1e999}']) {
    const { dir, open } = fixture(t)
    fs.writeFileSync(path.join(dir, 'state-u_one.json'), '{"workouts":[{"id":"keep"}]}')
    fs.writeFileSync(path.join(dir, 'state-u_two.json'), bad)
    assert.throws(open)
    assert.equal(fs.existsSync(path.join(dir, 'state-u_one.json')), true)
    assert.equal(fs.readFileSync(path.join(dir, 'state-u_two.json'), 'utf8'), bad)
    const inspect = openIntegrationStore(path.join(dir, 'profiles.sqlite'))
    assert.deepEqual(inspect.listProfiles(), [])
    assert.equal(inspect.getProfileMigration(), null)
    inspect.close()
  }
})

test('orphan, unsafe filename and symbolic-link inputs require explicit operator repair', t => {
  for (const name of ['state-orphan.json', 'state-bad.name.json']) {
    const { dir, open } = fixture(t)
    fs.writeFileSync(path.join(dir, name), '{}')
    assert.throws(open, /legacy_profile_owner/)
  }
  const { dir, open } = fixture(t)
  fs.writeFileSync(path.join(dir, 'elsewhere.json'), '{}')
  fs.symlinkSync(path.join(dir, 'elsewhere.json'), path.join(dir, 'state-u_one.json'))
  assert.throws(open, /legacy_profile_file/)
})

test('nonempty SQL without a migration marker is never overwritten by legacy files', t => {
  const { dir, open } = fixture(t)
  const prior = openIntegrationStore(path.join(dir, 'profiles.sqlite'))
  prior.commitProfile('u_one', 0, { original: true })
  prior.close()
  fs.writeFileSync(path.join(dir, 'state-u_one.json'), '{"wrong":true}')
  assert.throws(open, /migration_target_not_empty/)
  const inspect = openIntegrationStore(path.join(dir, 'profiles.sqlite'))
  assert.equal(inspect.getProfile('u_one').state.original, true)
  inspect.close()
})

test('archive interruption resumes without reimporting or allocating another profile revision', t => {
  const { dir, open } = fixture(t)
  const source = path.join(dir, 'state-u_one.json')
  fs.writeFileSync(source, '{"workouts":[{"id":"preserve"}]}')
  const rename = fs.renameSync
  const fault = t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === source) throw new Error('archive fault')
    return rename(from, to)
  })
  assert.throws(open, /archive fault/)
  fault.mock.restore()
  const recovered = open()
  assert.equal(recovered.getProfile('u_one').revision, 1)
  assert.equal(recovered.getProfile('u_one').state.workouts[0].id, 'preserve')
  assert.equal(recovered.getProfileMigration().archive_complete, true)
  assert.equal(fs.existsSync(source), false)
})

test('profile deletion cascades connection, stream and delivery records', t => {
  const { open } = fixture(t)
  const store = open()
  store.commitProfile('u_one', 0, { workouts: [] })
  const id = '22222222-2222-4222-8222-222222222222'
  store.createConnection('u_one', { id, peer_origin: 'https://peer.example.com', peer_user_id: 'remote', scopes: ['workout'] })
  store.activateConnection('u_one', id, { ciphertext: 'sealed', iv: 'iv', tag: 'tag' })
  store.commitProfile('u_one', 1, { workouts: [] }, [{ connection_id: id, resource: 'workout', entity_id: 'w1', operation: 'delete', payload: null }])
  store.deleteProfile('u_one')
  assert.equal(store.getProfile('u_one'), null)
  assert.deepEqual(store.pending('u_one'), [])
})

test('changed legacy files after a committed import stop retirement, never overwrite SQL', t => {
  const { dir, open } = fixture(t)
  const source = path.join(dir, 'state-u_one.json')
  fs.writeFileSync(source, '{"original":true}')
  const rename = fs.renameSync
  const fault = t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === source) throw new Error('archive fault')
    return rename(from, to)
  })
  assert.throws(open, /archive fault/)
  fault.mock.restore()
  fs.writeFileSync(source, '{"changed":true}')
  assert.throws(open, /legacy_profile_changed_during_migration/)
  const inspect = openIntegrationStore(path.join(dir, 'profiles.sqlite'))
  try {
    assert.equal(inspect.getProfile('u_one').state.original, true)
    assert.equal(inspect.getProfile('u_one').revision, 1)
    assert.equal(inspect.getProfileMigration().archive_complete, false)
  } finally { inspect.close() }
})
