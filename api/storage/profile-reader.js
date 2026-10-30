import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const STORE_FILENAME = 'profiles.sqlite'
const fault = () => Object.assign(new Error('profiles.sqlite is unavailable, unready or invalid'), { code: 'EIO' })

export function openProfileReader(dataDir) {
  let db
  let closed = false
  function guarded(fn) {
    try {
      if (closed) throw fault()
      return fn()
    } catch { throw fault() }
  }
  try {
    db = new DatabaseSync(path.join(dataDir, STORE_FILENAME), { readOnly: true })
    db.exec('PRAGMA query_only=ON')
    function ready() {
      if (![1, 10, 11, 12].includes(db.prepare('PRAGMA user_version').get().user_version)) throw fault()
      const marker = db.prepare('SELECT value FROM storage_metadata WHERE key=?').get('json_profiles_import_v1')
      if (typeof marker?.value !== 'string' || !marker.value.trim()) throw fault()
      JSON.parse(marker.value)
    }
    ready()
    const profile = db.prepare('SELECT revision,state FROM profiles WHERE owner_id=?')
    const revision = db.prepare('SELECT revision FROM profiles WHERE owner_id=?')
    const users = db.prepare('SELECT owner_id FROM profiles ORDER BY owner_id')
    const validRevision = value => {
      if (!Number.isSafeInteger(value) || value < 0) throw fault()
      return value
    }
    return {
      getProfile(uid) { return guarded(() => {
        ready()
        const row = profile.get(uid)
        if (!row) return null
        const state = JSON.parse(row.state)
        if (!state || typeof state !== 'object' || Array.isArray(state)) throw fault()
        return { revision: validRevision(row.revision), state }
      }) },
      getRevision(uid) { return guarded(() => {
        ready()
        const row = revision.get(uid)
        return row ? validRevision(row.revision) : null
      }) },
      getBodyProfile(uid) { return guarded(() => {
        ready()
        if (db.prepare('PRAGMA user_version').get().user_version < 2) return { managed: false, connection_id: null, source: null, revision: 0, definitions: [], measurements: [], target: null }
        db.exec('BEGIN')
        try {
          const source = db.prepare('SELECT * FROM body_sources WHERE owner_id=?').get(uid)
          const rows = source ? db.prepare('SELECT resource,entity_id,payload FROM body_entities WHERE owner_id=? AND source_id=? ORDER BY resource,entity_id').all(uid, source.source_id) : []
          const target = rows.find(row => row.resource === 'body_goal')
          const result = { managed: !!source, connection_id: source?.connection_id ?? null, source: source ? 'sparkyfitness' : null, revision: source?.revision ?? 0,
            definitions: rows.filter(row => row.resource === 'body_definition').map(row => JSON.parse(row.payload)),
            measurements: rows.filter(row => row.resource === 'body_measurement').map(row => ({ entity_id: row.entity_id, ...JSON.parse(row.payload) })), target: target ? JSON.parse(target.payload) : null }
          db.exec('COMMIT'); return result
        } catch (error) { db.exec('ROLLBACK'); throw error }
      }) },
      listUserIds() { return guarded(() => {
        ready()
        return users.all().map(row => {
          if (typeof row.owner_id !== 'string' || !row.owner_id) throw fault()
          return row.owner_id
        })
      }) },
      close() {
        if (!closed) { closed = true; db.close() }
      }
    }
  } catch {
    try { db?.close() } catch {}
    throw fault()
  }
}
