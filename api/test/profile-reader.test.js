import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openProfileReader, STORE_FILENAME } from '../storage/profile-reader.js'

function fixture(t, { version = 1, marker = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'profile-reader-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = new DatabaseSync(path.join(dir, STORE_FILENAME))
  t.after(() => db.close())
  db.exec(`PRAGMA user_version=${version}; CREATE TABLE profiles(owner_id TEXT PRIMARY KEY, revision INTEGER, state TEXT); CREATE TABLE storage_metadata(key TEXT PRIMARY KEY,value TEXT)`)
  if (marker) db.prepare('INSERT INTO storage_metadata VALUES (?,?)').run('json_profiles_import_v1', '{"complete":true}')
  return { dir, db }
}

test('missing database is refused without creating it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'profile-missing-'))
  try {
    assert.throws(() => openProfileReader(dir), { code: 'EIO' })
    assert.equal(existsSync(path.join(dir, STORE_FILENAME)), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('reads native rows, sees commits, isolates owners and closes idempotently', t => {
  const { dir, db } = fixture(t)
  db.prepare('INSERT INTO profiles VALUES (?,?,?)').run('alex', 2, '{"unit":"kg"}')
  const reader = openProfileReader(dir)
  assert.deepEqual(reader.getProfile('alex'), { revision: 2, state: { unit: 'kg' } })
  assert.equal(reader.getProfile("alex' OR 1=1 --"), null)
  assert.equal(reader.getRevision('missing'), null)
  assert.deepEqual(reader.listUserIds(), ['alex'])
  db.prepare('UPDATE profiles SET revision=3,state=?').run('{"unit":"lb"}')
  assert.equal(reader.getRevision('alex'), 3)
  assert.equal(reader.getProfile('alex').state.unit, 'lb')
  reader.close(); reader.close()
  assert.throws(() => reader.getProfile('alex'), { code: 'EIO' })
})
for (const options of [{ version: 2 }, { marker: false }]) {
  test(`refuses unready/unknown schema ${JSON.stringify(options)}`, t => {
    const { dir } = fixture(t, options)
    assert.throws(() => openProfileReader(dir), { code: 'EIO' })
  })
}
test('malformed rows and marker fail closed without leaking content or paths', t => {
  const { dir, db } = fixture(t)
  db.prepare('INSERT INTO profiles VALUES (?,?,?)').run('private-owner', 1, 'private malformed state')
  const reader = openProfileReader(dir)
  assert.throws(() => reader.getProfile('private-owner'), e => e.code === 'EIO' && !e.message.includes('private') && !e.message.includes(dir))
  reader.close()
  db.exec("UPDATE storage_metadata SET value='not-json'")
  assert.throws(() => openProfileReader(dir), { code: 'EIO' })
})
test('missing tables are refused even with a recognized user_version', t => {
  const { dir, db } = fixture(t)
  db.exec('DROP TABLE profiles')
  assert.throws(() => openProfileReader(dir), { code: 'EIO' })
})
test('invalid profile shapes and revisions are not returned', t => {
  const { dir, db } = fixture(t)
  const reader = openProfileReader(dir)
  t.after(() => reader.close())
  for (const [revision, state] of [[-1, '{}'], [1, 'null'], [1, '[]'], [1, '"private"']]) {
    db.prepare('INSERT OR REPLACE INTO profiles VALUES (?,?,?)').run('alex', revision, state)
    assert.throws(() => reader.getProfile('alex'), { code: 'EIO' })
  }
})
test('an opened reader rechecks readiness rather than serving an unready store', t => {
  const { dir, db } = fixture(t)
  const reader = openProfileReader(dir)
  t.after(() => reader.close())
  db.exec('DELETE FROM storage_metadata')
  assert.throws(() => reader.listUserIds(), { code: 'EIO' })
  assert.throws(() => reader.getRevision('alex'), { code: 'EIO' })
})
test('corrupt database refuses without exposing raw SQLite diagnostics', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'profile-corrupt-'))
  try {
    writeFileSync(path.join(dir, STORE_FILENAME), 'private invalid database')
    assert.throws(() => openProfileReader(dir), e => e.code === 'EIO' && !e.message.includes('private') && !e.message.includes(dir))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('reads do not modify the database and see committed WAL updates', t => {
  const { dir, db } = fixture(t)
  db.exec('PRAGMA journal_mode=WAL')
  db.prepare('INSERT INTO profiles VALUES (?,?,?)').run('alex', 1, '{}')
  const before = readFileSync(path.join(dir, STORE_FILENAME))
  const reader = openProfileReader(dir)
  assert.equal(reader.getRevision('alex'), 1)
  assert.deepEqual(reader.listUserIds(), ['alex'])
  assert.deepEqual(reader.getProfile('alex').state, {})
  reader.close()
  assert.deepEqual(readFileSync(path.join(dir, STORE_FILENAME)), before)
  const live = openProfileReader(dir)
  t.after(() => live.close())
  db.exec('BEGIN IMMEDIATE')
  db.prepare('UPDATE profiles SET revision=2').run()
  assert.equal(live.getRevision('alex'), 1)
  db.exec('COMMIT')
  assert.equal(live.getRevision('alex'), 2)
})
