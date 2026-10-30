import { describe, test, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dirs = [], writers = [], modules = []
const users = [{ id: 'alex', name: 'Alex', created: '2026-01-01' }, { id: 'private-partner', name: 'Partner' }]
function fixture(profiles = [['alex', 1, { unit: 'lb' }]], accounts = users.slice(0, 1)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkygym-acceptance-mcp-state-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: accounts, creds: ['secret'], subs: ['secret'] }))
  const db = new DatabaseSync(path.join(dir, 'profiles.sqlite'))
  writers.push(db)
  db.exec('PRAGMA user_version=1; CREATE TABLE profiles(owner_id TEXT PRIMARY KEY,revision INTEGER,state TEXT); CREATE TABLE storage_metadata(key TEXT PRIMARY KEY,value TEXT);')
  db.prepare('INSERT INTO storage_metadata VALUES (?,?)').run('json_profiles_import_v1', '{"complete":true}')
  for (const [uid, rev, state] of profiles) db.prepare('INSERT INTO profiles VALUES (?,?,?)').run(uid, rev, JSON.stringify(state))
  return { dir, db }
}
async function load(dir, uid = 'alex') {
  vi.resetModules()
  vi.stubEnv('OPENGYM_DATA', dir)
  vi.stubEnv('OPENGYM_UID', uid)
  const mod = await import('../src/state.js')
  modules.push(mod)
  return mod
}
afterEach(() => {
  for (const mod of modules.splice(0)) mod._seedStateForTests(null)
  for (const db of writers.splice(0)) db.close()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs(); vi.restoreAllMocks()
})

describe('native read-only state', () => {
  function pairedFixture() {
    const result = fixture([['alex', 7, { unit: 'kg', _rev: 3, bodyweight: [], targetW: null }]])
    result.db.exec(`PRAGMA user_version=10;
      CREATE TABLE body_sources(owner_id TEXT PRIMARY KEY, source_id TEXT, connection_id TEXT, revision INTEGER);
      CREATE TABLE body_entities(owner_id TEXT, source_id TEXT, resource TEXT, entity_id TEXT, payload TEXT);
      INSERT INTO body_sources VALUES ('alex','sf','conn',1);`)
    const insert = result.db.prepare('INSERT INTO body_entities VALUES (?,?,?,?,?)')
    insert.run('alex', 'sf', 'body_measurement', 'weight-1', JSON.stringify({ metric_id: 'weight', date: '2026-10-29', value: 81, unit: 'kg' }))
    insert.run('alex', 'sf', 'body_measurement', 'unknown-1', JSON.stringify({ metric_id: 'source_metric', date: '2026-10-29', value: 12, unit: 'widgets', definition: { label: 'Source original name', value_type: 'number', builtin: false } }))
    insert.run('alex', 'sf', 'body_goal', 'goal', JSON.stringify({ value: 75 }))
    return result
  }
  test('paired canonical body replaces archived empty profile fields', async () => {
    const { dir } = pairedFixture()
    const state = (await load(dir)).getState()
    expect(state.bodyweight).toEqual([{ id: 'weight-1', d: '2026-10-29', w: 81 }])
    expect(state.targetW).toBe(75)
    expect(state._rev).toBe(3)
    expect(state.measurements[0].other[0]).toMatchObject({ name: 'Source original name', unit: 'widgets', value: 12 })
  })
  test('body-only correction invalidates cache without changing profile revision or source names and units', async () => {
    const { dir, db } = pairedFixture()
    const mod = await load(dir)
    const first = mod.getState()
    expect(mod.getState()).toBe(first)
    db.prepare("UPDATE body_entities SET payload=json_set(payload,'$.value',14) WHERE entity_id='unknown-1'").run()
    db.exec('UPDATE body_sources SET revision=2')
    const corrected = mod.getState()
    expect(corrected).not.toBe(first)
    expect(corrected.measurements[0].other[0]).toMatchObject({ name: 'Source original name', unit: 'widgets', value: 14 })
    expect(corrected.customMeasurements[0]).toMatchObject({ name: 'Source original name', unit: 'widgets' })
    expect(corrected._rev).toBe(3)
    expect(db.prepare('SELECT revision FROM profiles').get().revision).toBe(7)
    db.exec("UPDATE body_sources SET connection_id='replacement'")
    const reconnected = mod.getState()
    expect(reconnected).not.toBe(corrected)
    db.exec('DELETE FROM body_sources')
    expect(mod.getState().bodyweight).toEqual([])
  })
  test('merges defaults, caches by revision, sees writes and deletes', async () => {
    const { dir, db } = fixture()
    db.prepare('UPDATE profiles SET state=?').run('{"unit":"lb","_rev":5}')
    const mod = await load(dir)
    const first = mod.getState()
    expect(first.unit).toBe('lb')
    expect(first.dayPlan).toEqual({})
    expect(mod.getState()).toBe(first)
    db.prepare('UPDATE profiles SET revision=2,state=?').run('{"unit":"kg","_rev":5}')
    expect(mod.getState().unit).toBe('kg')
    expect(mod.getState()._rev).toBe(5) // Public sync revisions are not SQL cache revisions.
    db.exec('DELETE FROM profiles')
    expect(mod.getState()).toBeNull()
    db.prepare('INSERT INTO profiles VALUES (?,?,?)').run('alex', 3, '{"unit":"lb"}')
    expect(mod.getState().unit).toBe('lb')
  })
  test('fresh account returns null only in a ready database', async () => {
    const { dir } = fixture([])
    expect((await load(dir)).getState()).toBeNull()
  })
  test('missing database refuses legacy files without creating SQL storage', async () => {
    const { dir, db } = fixture([])
    db.close(); writers.pop()
    fs.rmSync(path.join(dir, 'profiles.sqlite'))
    fs.writeFileSync(path.join(dir, 'state-alex.json'), '{"unit":"lb"}')
    const mod = await load(dir)
    expect(() => mod.getState()).toThrow(/profiles.sqlite/)
    expect(fs.existsSync(path.join(dir, 'profiles.sqlite'))).toBe(false)
  })
  test('malformed state fails closed and clears cached state', async () => {
    const { dir, db } = fixture()
    const mod = await load(dir)
    mod.getState()
    db.prepare('UPDATE profiles SET revision=2,state=?').run('private malformed JSON')
    expect(() => mod.getState()).toThrow(/profiles.sqlite/)
    db.prepare('UPDATE profiles SET state=?').run('{"unit":"kg"}')
    expect(mod.getState().unit).toBe('kg')
  })
  test('marker removal refuses even cached state', async () => {
    const { dir, db } = fixture()
    const mod = await load(dir)
    mod.getState()
    db.exec('DELETE FROM storage_metadata')
    expect(() => mod.getState()).toThrow(/profiles.sqlite/)
  })
  test('user metadata stays private and independent of profiles', async () => {
    const { dir } = fixture()
    const mod = await load(dir)
    expect(mod.getUser()).toEqual(users[0])
    expect(mod.localUid()).toBe('alex')
  })
  test('seeded states never open storage', async () => {
    const mod = await load('/missing-test-directory')
    mod._seedStateForTests({ unit: 'kg' })
    expect(mod.getState()).toEqual({ unit: 'kg' })
    mod._seedStateForTests(null)
    expect(mod.getState()).toBeNull()
  })
  test('single SQL profile is selected without scanning legacy files', async () => {
    const { dir } = fixture()
    fs.writeFileSync(path.join(dir, 'state-other.json'), '{}')
    expect((await load(dir, '')).localUid()).toBe('alex')
  })
  test('remote-only identity needs no database, but explicit broken local data fails closed', async () => {
    const { dir } = fixture([])
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    vi.resetModules()
    vi.stubEnv('OPENGYM_DATA', '')
    vi.stubEnv('OPENGYM_UID', '')
    const remote = await import('../src/state.js')
    expect(remote.localUid()).toBeNull()
    expect(() => remote.getState()).toThrow(/profiles.sqlite/)
    const explicit = await load(path.join(dir, 'missing'), '')
    expect(() => explicit.localUid()).toThrow(/profiles.sqlite/)
    const pinned = await load(path.join(dir, 'missing'), 'alex')
    expect(pinned.localUid()).toBe('alex')
    expect(() => pinned.getState()).toThrow(/profiles.sqlite/)
  })
  for (const profiles of [[], users.map(u => [u.id, 1, {}])]) {
    test(`ambiguity discloses roster only on stderr (${profiles.length} synced)`, async () => {
      const { dir } = fixture(profiles, users)
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mod = await load(dir, '')
      let error
      try { mod.getState() } catch (e) { error = e }
      expect(error.code).toBe('EINVAL')
      expect(error.message).toContain('holds 2 profiles')
      expect(error.message).not.toContain(dir)
      expect(error.message).not.toContain('private-partner')
      expect(log.mock.calls.flat().join(' ')).toContain('private-partner')
    })
  }
})
