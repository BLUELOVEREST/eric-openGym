// Connections open on the first local read, never at module import (coach imports this too).
import fs from 'node:fs'
import path from 'node:path'
import { openProfileReader } from '../../api/storage/profile-reader.js'
import { composeBodyState } from '../../api/integrations/sparkygym-body-model.js'

const DATA_DIR = process.env.OPENGYM_DATA || path.join(process.cwd(), 'data')
const DATA_SET = !!process.env.OPENGYM_DATA
let _state, _db, _revision
let _uid = null
let _reader = null
let _seeded = false

function reloadDb() {
  try {
    _db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'))
    if (!Array.isArray(_db.users)) throw new Error()
  } catch (e) {
    if (e.code === 'ENOENT') _db = { users: [] }
    else throw Object.assign(new Error('cannot read db.json: invalid or unavailable user metadata'), { code: 'EIO' })
  }
}

function ambiguousUid(ids) {
  console.error(`[opengym-mcp] ${ids.length} openGym profiles in ${DATA_DIR}: ${ids.join(', ')} — set OPENGYM_UID to one of them`)
  return Object.assign(new Error(`this openGym data directory holds ${ids.length} profiles — set OPENGYM_UID to the one this server should read (the ids are on the server's stderr, and in db.json under "users"[].id)`), { code: 'EINVAL' })
}

function resolveUid(reader) {
  const envUid = (process.env.OPENGYM_UID || '').trim()
  if (envUid) {
    if (!/^[a-zA-Z0-9_-]+$/.test(envUid)) throw new Error('OPENGYM_UID contains invalid characters')
    return envUid
  }
  const ids = reader.listUserIds()
  if (ids.length === 1) return ids[0]
  if (ids.length > 1) throw ambiguousUid(ids)
  if (_db.users.length === 1) return _db.users[0].id
  if (_db.users.length > 1) throw ambiguousUid(_db.users.map(u => u.id))
  throw new Error('no openGym users found — sign in at least once on a device')
}

export function init() {
  if (_uid !== null) return
  const reader = openProfileReader(DATA_DIR)
  try {
    reloadDb()
    const uid = resolveUid(reader)
    _reader = reader
    _uid = uid
  } catch (e) { reader.close(); throw e }
}

export function getState() {
  if (_seeded) return _state
  init()
  try {
    const revision = _reader.getRevision(_uid)
    const body = _reader.getBodyProfile(_uid)
    const stamp = JSON.stringify([revision, body.revision, body.managed, body.connection_id])
    if (_state === undefined || stamp !== _revision) {
      const profile = _reader.getProfile(_uid)
      _state = profile ? composeBodyState(Object.assign({}, defaultsShape(), profile.state), body) : null
      _revision = JSON.stringify([profile?.revision ?? null, body.revision, body.managed, body.connection_id])
    }
    return _state
  } catch (e) { invalidate(); throw e }
}

// Never return credential, subscription or other-user metadata.
export function getUser() {
  init()
  const u = _db.users.find(x => x.id === _uid) || { id: _uid, name: 'Profile', created: null }
  return { id: u.id, name: u.name, created: u.created || null }
}
export const dataDir = () => DATA_DIR

export function localUid() {
  if (_uid !== null) return _uid
  const envUid = (process.env.OPENGYM_UID || '').trim()
  if (envUid) return envUid
  if (!DATA_SET && !fs.existsSync(DATA_DIR)) return null
  init()
  return _uid
}

export function invalidate() { _state = undefined; _revision = undefined }

export function _seedStateForTests(state) {
  _reader?.close()
  _reader = null
  _uid = 'test-uid'
  _db = { users: [{ id: _uid, name: 'Test', created: '2026-07-26T00:00:00.000Z' }] }
  _state = state
  _seeded = true
}

function defaultsShape() {
  return {
    unit: 'kg', restSec: 90, sound: true, lang: 'en',
    theme: 'dark', accent: 'lime', body: 'male', targetW: null,
    bodyweight: [], routines: [], week: {}, dayPlan: {},
    exWeights: {}, workouts: [], customEx: [], gifSize: 'full',
    reminder: { on: false, time: '08:00', tz: null }
  }
}
