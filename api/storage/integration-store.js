import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { isUuid, parseEvent, parseReceipt, RESOURCE_PRODUCERS } from '../integrations/sparkygym-protocol.js'
import { INTEGRATION_SCHEMA_V2, INTEGRATION_SCHEMA_V3, INTEGRATION_SCHEMA_V4, INTEGRATION_SCHEMA_V5, INTEGRATION_SCHEMA_V6, INTEGRATION_SCHEMA_V7, INTEGRATION_SCHEMA_V8, INTEGRATION_SCHEMA_V9, INTEGRATION_SCHEMA_V10, INTEGRATION_SCHEMA_V11, INTEGRATION_SCHEMA_V12 } from './integration-schema-v2.js'
import { hasManagedBodyFields, stripManagedBodyFields, MANAGED_BODY_FIELDS } from '../integrations/sparkygym-body-model.js'
import { validateBodyPayload } from '../integrations/sparkygym-body-validation.js'
import { normalizeTrainingIdentities, trainingChanges, exportNativeEntities } from '../integrations/sparkygym-export.js'
import { membershipHash, validateSnapshot } from '../integrations/sparkygym-snapshot.js'
import { parseDomainEvent } from '../integrations/sparkygym-domain.js'
import { calendarDay } from '../integrations/training-hints-model.js'

const fail = code => { throw new Error(code) }
const hash = body => createHash('sha256').update(body).digest('hex')
const ownerId = value => {
  if (typeof value !== 'string' || !value.length || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail('invalid_owner')
}
const safeRevision = value => Number.isSafeInteger(value) && value >= 0
function encode(value) {
  const seen = new Set()
  const visit = (item, level) => {
    if (level > 256) fail('invalid_json')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || seen.has(item) ||
      (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) fail('invalid_json')
    seen.add(item)
    const descriptors = Object.getOwnPropertyDescriptors(item)
    const copy = Array.isArray(item) ? Object.setPrototypeOf([], null) : Object.create(null)
    const keys = Array.isArray(item)
      ? Array.from({ length: descriptors.length.value }, (_, i) => String(i))
      : Object.keys(descriptors).filter(key => descriptors[key].enumerable)
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (descriptor && !Object.hasOwn(descriptor, 'value')) fail('invalid_json')
      copy[key] = descriptor ? visit(descriptor.value, level + 1) : null
    }
    seen.delete(item)
    return copy
  }
  return JSON.stringify(visit(value, 0))
}
function profileJson(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('invalid_profile')
  if (Object.hasOwn(state, '_sparkygym')) fail('private_state_forbidden')
  return encode(state)
}

const SCHEMA = `
CREATE TABLE storage_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK(json_valid(value))
) STRICT;
CREATE TABLE profiles (
  owner_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision > 0 AND revision <= 9007199254740991),
  state TEXT NOT NULL CHECK(json_valid(state))
) STRICT;
CREATE TABLE connections (
  id TEXT COLLATE NOCASE PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES profiles(owner_id) ON DELETE CASCADE,
  peer_origin TEXT NOT NULL,
  allow_insecure_http INTEGER NOT NULL DEFAULT 0 CHECK(allow_insecure_http IN (0,1)),
  peer_user_id TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK(json_valid(scopes)),
  status TEXT NOT NULL CHECK(status IN ('pending','active','revoked')),
  sealed_keys TEXT CHECK(sealed_keys IS NULL OR json_valid(sealed_keys)),
  UNIQUE(id,owner_id),
  CHECK(status != 'active' OR sealed_keys IS NOT NULL),
  CHECK(peer_origin NOT LIKE 'http:%' OR allow_insecure_http=1)
) STRICT;
CREATE TABLE streams (
  connection_id TEXT COLLATE NOCASE NOT NULL,
  owner_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  outgoing_revision INTEGER NOT NULL DEFAULT 0 CHECK(outgoing_revision BETWEEN 0 AND 9007199254740991),
  incoming_revision INTEGER NOT NULL DEFAULT 0 CHECK(incoming_revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(connection_id,resource,entity_id),
  FOREIGN KEY(connection_id,owner_id) REFERENCES connections(id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE outbox (
  event_id TEXT COLLATE NOCASE PRIMARY KEY,
  connection_id TEXT COLLATE NOCASE NOT NULL,
  owner_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  body BLOB NOT NULL,
  body_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at >= 0),
  last_error TEXT,
  receipt TEXT CHECK(receipt IS NULL OR json_valid(receipt)),
  UNIQUE(connection_id,resource,entity_id,revision),
  FOREIGN KEY(connection_id,owner_id) REFERENCES connections(id,owner_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX outbox_due ON outbox(owner_id,status,next_attempt_at);
CREATE TABLE inbox (
  event_id TEXT COLLATE NOCASE NOT NULL,
  connection_id TEXT COLLATE NOCASE NOT NULL,
  owner_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  receipt TEXT NOT NULL CHECK(json_valid(receipt)),
  PRIMARY KEY(connection_id,event_id),
  FOREIGN KEY(connection_id,owner_id) REFERENCES connections(id,owner_id) ON DELETE CASCADE
) STRICT;
PRAGMA user_version = 1;
`

// Trusted service primitive, not an HTTP/auth boundary. Callers bind owner from the
// authenticated session or paired key and validate resource payloads before commit.
export function openIntegrationStore(filename) {
  if (filename !== ':memory:') {
    try { fs.closeSync(fs.openSync(filename, 'wx', 0o600)) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    if (!fs.lstatSync(filename).isFile()) fail('invalid_database_file')
    fs.chmodSync(filename, 0o600)
  }
  const db = new DatabaseSync(filename)
  let closed = false, inTransaction = false
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    db.exec('BEGIN IMMEDIATE')
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version === 0) db.exec(SCHEMA)
    else if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(version)) fail('unsupported_database_version')
    if (version < 2) db.exec(INTEGRATION_SCHEMA_V2)
    if (version < 3) db.exec(INTEGRATION_SCHEMA_V3)
    if (version < 4) db.exec(INTEGRATION_SCHEMA_V4)
    if (version < 5) db.exec(INTEGRATION_SCHEMA_V5)
    if (version < 6) db.exec(INTEGRATION_SCHEMA_V6)
    if (version < 7) db.exec(INTEGRATION_SCHEMA_V7)
    if (version < 8) db.exec(INTEGRATION_SCHEMA_V8)
    if (version < 9) db.exec(INTEGRATION_SCHEMA_V9)
    if (version < 10) db.exec(INTEGRATION_SCHEMA_V10)
    if (version < 11) db.exec(INTEGRATION_SCHEMA_V11)
    if (version < 12) db.exec(INTEGRATION_SCHEMA_V12)
    db.exec('COMMIT')
  } catch (error) { db.close(); throw error }

  function transaction(fn) {
    if (closed) fail('store_closed')
    if (inTransaction) fail('nested_transaction')
    db.exec('BEGIN IMMEDIATE')
    inTransaction = true
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') }
      catch { db.close(); closed = true }
      throw error
    } finally { inTransaction = false }
  }
  function getProfile(owner) {
    ownerId(owner)
    const row = db.prepare('SELECT revision,state FROM profiles WHERE owner_id=?').get(owner)
    if (!row) return null
    const state = JSON.parse(row.state)
    if (!state || typeof state !== 'object' || Array.isArray(state)) fail('invalid_profile')
    return { revision: row.revision, state }
  }
  function putProfile(owner, state) {
    const text = profileJson(state)
    const current = getProfile(owner)
    const revision = (current?.revision ?? 0) + 1
    if (!Number.isSafeInteger(revision)) fail('revision_exhausted')
    db.prepare('INSERT INTO profiles(owner_id,revision,state) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision,state=excluded.state').run(owner, revision, text)
    return revision
  }
  function connectionFor(owner, id, resource) {
    ownerId(owner)
    const row = db.prepare('SELECT * FROM connections WHERE id=? AND owner_id=?').get(id, owner)
    if (!row) fail('connection_unavailable')
    if (row.status !== 'active' || row.paused) fail('connection_inactive')
    if (resource && !JSON.parse(row.scopes).includes(resource)) fail('scope_denied')
    return row
  }
  function streamFor(owner, event) {
    db.prepare('INSERT OR IGNORE INTO streams(connection_id,owner_id,resource,entity_id) VALUES(?,?,?,?)').run(event.connection_id, owner, event.resource, event.entity_id)
    return db.prepare('SELECT * FROM streams WHERE connection_id=? AND resource=? AND entity_id=?').get(event.connection_id, event.resource, event.entity_id)
  }
  function enqueue(owner, change, capture = false) {
    if (!change || RESOURCE_PRODUCERS[change.resource] !== 'opengym') fail('direction_denied')
    if (capture) {
      const connection = service.getConnection(owner, change.connection_id)
      if (connection?.status !== 'active' || !connection.scopes.includes(change.resource)) fail('connection_inactive')
    } else connectionFor(owner, change.connection_id, change.resource)
    const stream = streamFor(owner, change)
    const revision = stream.outgoing_revision + 1
    const sourceCursor = Number(JSON.parse(db.prepare("SELECT value FROM storage_metadata WHERE key='outgoing_source_cursor'").get().value)) + 1
    if (!Number.isSafeInteger(sourceCursor)) fail('source_cursor_exhausted')
    db.prepare("UPDATE storage_metadata SET value=? WHERE key='outgoing_source_cursor'").run(String(sourceCursor))
    const event = {
      version: 1, event_id: randomUUID(), connection_id: change.connection_id, producer: 'opengym',
      resource: change.resource, entity_id: change.entity_id, revision, operation: change.operation,
      occurred_at: new Date().toISOString(), payload: change.payload, source_cursor: sourceCursor,
    }
    const body = Buffer.from(encode(event))
    parseEvent(body)
    if (service.getConnection(owner, event.connection_id)?.binding !== null) parseDomainEvent(body)
    db.prepare('UPDATE streams SET outgoing_revision=? WHERE connection_id=? AND resource=? AND entity_id=?').run(revision, event.connection_id, event.resource, event.entity_id)
    db.prepare('INSERT INTO outbox(event_id,connection_id,owner_id,resource,entity_id,revision,body,body_hash,source_cursor,delivery_order) VALUES(?,?,?,?,?,?,?,?,?,?)').run(event.event_id, event.connection_id, owner, event.resource, event.entity_id, revision, body, hash(body), sourceCursor, nextOrder())
    if (event.resource === 'personal_media' && event.operation === 'delete') {
      db.prepare("DELETE FROM integration_media_transfers WHERE owner_id=? AND connection_id=? AND status IN ('pending','terminal') AND json_extract(metadata,'$.media_id')=?").run(owner, event.connection_id, event.entity_id)
    }
    if (event.resource === 'personal_media' && event.operation === 'upsert') {
      const requestId = randomUUID(), payload = event.payload
      const metadata = { connection_id: event.connection_id, request_id: requestId, media_id: payload.media_id, sha256: payload.sha256, bytes: payload.bytes, mime: payload.mime }
      db.prepare('INSERT INTO integration_media_transfers(request_id,owner_id,connection_id,event_id,metadata) VALUES(?,?,?,?,?)').run(requestId, owner, event.connection_id, event.event_id, encode(metadata))
    }
    return event.event_id
  }
  function outboxFor(owner, id) {
    ownerId(owner)
    const row = db.prepare('SELECT * FROM outbox WHERE owner_id=? AND event_id=?').get(owner, id)
    if (!row) fail('event_unavailable')
    return row
  }
  function nextOrder() {
    const next = Number(db.prepare("SELECT value FROM storage_metadata WHERE key='delivery_cursor'").get().value) + 1
    if (!Number.isSafeInteger(next)) fail('delivery_cursor_exhausted')
    db.prepare("UPDATE storage_metadata SET value=? WHERE key='delivery_cursor'").run(String(next))
    return next
  }
  function insertControl(owner, id, method, path, body, requestId = randomUUID()) {
    db.prepare('INSERT INTO integration_controls(request_id,owner_id,connection_id,method,path,body,delivery_order) VALUES(?,?,?,?,?,?,?)').run(requestId, owner, id, method, path, body, nextOrder())
    return requestId
  }
  function noteDelivery(owner, id) {
    db.prepare("INSERT INTO integration_notifications(owner_id,connection_id,kind,payload) VALUES(?,?,'delivery_changed',?)").run(owner, id, encode({ connection_id: id }))
  }
  function recordExportFailures(owner, connection, failures) {
    const next = [...new Map(failures.filter(value => connection.scopes.includes(value.resource)).map(value => [value.resource + '\n' + value.entity_id, { resource: value.resource, entity_id: value.entity_id, error_code: value.code }])).values()].sort((a, b) => (a.resource + '\n' + a.entity_id).localeCompare(b.resource + '\n' + b.entity_id))
    const previous = db.prepare('SELECT resource,entity_id,error_code FROM integration_export_failures WHERE owner_id=? AND connection_id=? ORDER BY resource,entity_id').all(owner, connection.id)
    if (JSON.stringify(previous) === JSON.stringify(next)) return
    db.prepare('DELETE FROM integration_export_failures WHERE owner_id=? AND connection_id=?').run(owner, connection.id)
    for (const failure of next) db.prepare('INSERT INTO integration_export_failures(owner_id,connection_id,resource,entity_id,error_code,updated_at) VALUES(?,?,?,?,?,?)').run(owner, connection.id, failure.resource, failure.entity_id, failure.error_code, new Date().toISOString())
    noteDelivery(owner, connection.id)
  }
  const snapshotTransaction = fn => inTransaction ? fn() : transaction(fn)
  function recordMembership(owner, event) {
    const snapshot = db.prepare("SELECT * FROM incoming_snapshots WHERE owner_id=? AND connection_id=? AND status='open' AND start_cursor<=? AND watermark>=?").get(owner, event.connection_id, event.source_cursor ?? 0, event.source_cursor ?? 0)
    if (snapshot && event.operation === 'upsert') db.prepare('INSERT OR IGNORE INTO incoming_snapshot_members(snapshot_id,resource,entity_id) VALUES(?,?,?)').run(snapshot.snapshot_id, event.resource, event.entity_id)
  }

  function bodyProfile(owner) {
    return inTransaction ? readBodyProfile(owner) : transaction(() => readBodyProfile(owner))
  }
  function readBodyProfile(owner) {
    ownerId(owner)
    const source = db.prepare('SELECT * FROM body_sources WHERE owner_id=?').get(owner)
    if (!source) return { managed: false, connection_id: null, source: null, revision: 0, definitions: [], measurements: [], target: null }
    const rows = db.prepare('SELECT resource,entity_id,payload FROM body_entities WHERE owner_id=? AND source_id=? ORDER BY resource,entity_id').all(owner, source.source_id)
    return { managed: true, connection_id: source.connection_id, source: 'sparkyfitness', revision: source.revision,
      definitions: rows.filter(row => row.resource === 'body_definition').map(row => JSON.parse(row.payload)),
      measurements: rows.filter(row => row.resource === 'body_measurement').map(row => ({ entity_id: row.entity_id, ...JSON.parse(row.payload) })),
      target: rows.find(row => row.resource === 'body_goal') ? JSON.parse(rows.find(row => row.resource === 'body_goal').payload) : null }
  }
  function projectBody(owner, event) {
    if (event.operation === 'upsert') validateBodyPayload(event.resource, event.payload)
    const source = db.prepare('SELECT * FROM body_sources WHERE owner_id=? AND connection_id=?').get(owner, event.connection_id)
    if (!source) fail('body_source_unavailable')
    if (!Number.isSafeInteger(event.source_cursor) || event.source_cursor < 1) fail('source_cursor_required')
    if (event.operation === 'delete') db.prepare('DELETE FROM body_entities WHERE owner_id=? AND source_id=? AND resource=? AND entity_id=?').run(owner, source.source_id, event.resource, event.entity_id)
    else db.prepare('INSERT INTO body_entities(owner_id,source_id,resource,entity_id,payload,last_source_cursor) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,source_id,resource,entity_id) DO UPDATE SET payload=excluded.payload,last_source_cursor=excluded.last_source_cursor').run(owner, source.source_id, event.resource, event.entity_id, encode(event.payload), event.source_cursor)
    db.prepare('UPDATE body_sources SET revision=revision+1 WHERE owner_id=?').run(owner)
    db.prepare("INSERT INTO integration_notifications(owner_id,connection_id,kind,payload) VALUES(?,?,'body_changed',?)").run(owner, event.connection_id, encode({ resource: event.resource, entity_id: event.entity_id }))
  }
  function bumpHints(owner, id) {
    db.prepare('INSERT INTO training_hint_revisions(owner_id,revision) VALUES(?,1) ON CONFLICT(owner_id) DO UPDATE SET revision=revision+1').run(owner)
    db.prepare("INSERT INTO integration_notifications(owner_id,connection_id,kind,payload) VALUES(?,?,'training_hints_changed','{}')").run(owner, id)
  }
  function projectHint(owner, event) {
    const source = db.prepare('SELECT * FROM incoming_sources WHERE owner_id=? AND connection_id=?').get(owner, event.connection_id)
    if (!source) fail('incoming_source_unavailable')
    if (event.operation === 'delete') db.prepare('DELETE FROM training_hints WHERE owner_id=? AND source_id=? AND entity_id=?').run(owner, source.source_id, event.entity_id)
    else db.prepare('INSERT INTO training_hints(owner_id,source_id,entity_id,payload,last_source_cursor) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,source_id,entity_id) DO UPDATE SET payload=excluded.payload,last_source_cursor=excluded.last_source_cursor').run(owner, source.source_id, event.entity_id, encode(event.payload), event.source_cursor)
    bumpHints(owner, event.connection_id)
  }
  const service = {
    getProfile,
    getTrainingHints(owner, date = null) {
      ownerId(owner)
      if (date !== null && !calendarDay(date)) fail('invalid_date')
      return snapshotTransaction(() => {
        const revision = db.prepare('SELECT revision FROM training_hint_revisions WHERE owner_id=?').get(owner)?.revision ?? 0
        const hints = db.prepare('SELECT entity_id,payload FROM training_hints WHERE owner_id=? ORDER BY entity_id').all(owner).map(row => ({ entity_id: row.entity_id, ...JSON.parse(row.payload) })).filter(hint => date === null || date >= hint.effective_from && (hint.effective_until === null || date <= hint.effective_until))
        return { revision, date, hints }
      })
    },
    deliveryStatus(owner, id) {
      ownerId(owner)
      const events = db.prepare("SELECT COUNT(*) FILTER(WHERE status='pending' AND terminal=0) AS pending,COUNT(*) FILTER(WHERE terminal=1 AND last_error!='superseded_snapshot') AS failed FROM outbox WHERE owner_id=? AND connection_id=?").get(owner, id)
      const controls = db.prepare("SELECT COUNT(*) FILTER(WHERE status='pending') AS pending,COUNT(*) FILTER(WHERE status='terminal') AS failed FROM integration_controls WHERE owner_id=? AND connection_id=?").get(owner, id)
      const media = db.prepare("SELECT COUNT(*) FILTER(WHERE status='pending') AS pending,COUNT(*) FILTER(WHERE status='terminal') AS failed FROM integration_media_transfers WHERE owner_id=? AND connection_id=?").get(owner, id)
      const successes = db.prepare('SELECT MAX(delivered_at) AS latest FROM (SELECT delivered_at FROM outbox WHERE owner_id=? AND connection_id=? UNION ALL SELECT delivered_at FROM integration_controls WHERE owner_id=? AND connection_id=? UNION ALL SELECT delivered_at FROM integration_media_transfers WHERE owner_id=? AND connection_id=?)').get(owner, id, owner, id, owner, id)
      const error = db.prepare("SELECT last_error FROM (SELECT last_error,updated_at FROM outbox WHERE owner_id=? AND connection_id=? AND last_error IS NOT NULL AND last_error!='superseded_snapshot' UNION ALL SELECT last_error,updated_at FROM integration_controls WHERE owner_id=? AND connection_id=? AND last_error IS NOT NULL UNION ALL SELECT last_error,updated_at FROM integration_media_transfers WHERE owner_id=? AND connection_id=? AND last_error IS NOT NULL) ORDER BY updated_at DESC LIMIT 1").get(owner, id, owner, id, owner, id)
      const conflict = db.prepare("SELECT json_extract(payload,'$.code') AS code FROM integration_notifications WHERE owner_id=? AND connection_id=? AND kind='integration_conflict' ORDER BY cursor DESC LIMIT 1").get(owner, id)
      const exports = db.prepare('SELECT COUNT(*) AS failed,MAX(error_code) AS code FROM integration_export_failures WHERE owner_id=? AND connection_id=?').get(owner, id)
      return { pending: events.pending + controls.pending, failed: events.failed + controls.failed + media.failed + exports.failed, pending_media: media.pending, last_success_at: successes.latest, last_error_code: conflict?.code ?? exports.code ?? (error && /^[a-z_]{1,64}$/.test(error.last_error) ? error.last_error : null) }
    },
    getConnection(owner, id) {
      ownerId(owner)
      const row = db.prepare('SELECT * FROM connections WHERE owner_id=? AND id=?').get(owner, id)
      return row ? { ...row, scopes: JSON.parse(row.scopes), binding: row.binding ? JSON.parse(row.binding) : null, sealed_keys: row.sealed_keys ? JSON.parse(row.sealed_keys) : null, capabilities: row.capabilities ? JSON.parse(row.capabilities) : null } : null
    },
    saveCapabilities(owner, id, capabilities) {
      ownerId(owner)
      transaction(() => db.prepare('UPDATE connections SET capabilities=? WHERE owner_id=? AND id=?').run(encode(capabilities), owner, id))
    },
    listConnections(owner) {
      ownerId(owner)
      return db.prepare('SELECT id FROM connections WHERE owner_id=? ORDER BY rowid').all(owner).map(row => service.getConnection(owner, row.id))
    },
    findPeerConnection(id) {
      if (!isUuid(id)) return null
      const row = db.prepare('SELECT owner_id FROM connections WHERE id=?').get(id)
      return row ? service.getConnection(row.owner_id, id) : null
    },
    prepareConnection(owner, id, binding, sealedKeys, allowPrivate = false) {
      ownerId(owner)
      transaction(() => {
        if (!service.getConnection(owner, id)) fail('connection_unavailable')
        const result = db.prepare("UPDATE connections SET binding=?,sealed_keys=?,allow_private_network=? WHERE owner_id=? AND id=? AND status='pending' AND binding IS NULL").run(encode(binding), encode(sealedKeys), allowPrivate === true ? 1 : 0, owner, id)
        if (!result.changes) fail('connection_conflict')
      })
    },
    pauseConnection(owner, id, paused) {
      ownerId(owner)
      return transaction(() => {
        const result = db.prepare("UPDATE connections SET paused=? WHERE owner_id=? AND id=? AND status='active'").run(paused ? 1 : 0, owner, id)
        if (!result.changes) fail('connection_unavailable')
        if (!paused) {
          db.prepare("UPDATE outbox SET next_attempt_at=0 WHERE owner_id=? AND connection_id=? AND status='pending' AND terminal=0").run(owner, id)
          db.prepare("UPDATE integration_controls SET next_attempt_at=0 WHERE owner_id=? AND connection_id=? AND status='pending'").run(owner, id)
          db.prepare("UPDATE integration_media_transfers SET next_attempt_at=0 WHERE owner_id=? AND connection_id=? AND status='pending'").run(owner, id)
        }
        noteDelivery(owner, id)
      })
    },
    enqueueControl(owner, id, method, path, body, requestId = randomUUID()) {
      ownerId(owner)
      if (!Buffer.isBuffer(body)) fail('invalid_control')
      return transaction(() => {
        if (!service.getConnection(owner, id)) fail('connection_unavailable')
        insertControl(owner, id, method, path, body, requestId)
        return requestId
      })
    },
    pendingControls(now = Date.now()) {
      return db.prepare("SELECT j.* FROM integration_controls j JOIN connections c ON c.id=j.connection_id WHERE j.status='pending' AND j.next_attempt_at<=? AND (j.path='/api/integrations/v1/revoke' OR c.status!='revoked' AND c.paused=0 AND NOT EXISTS(SELECT 1 FROM integration_controls e WHERE e.connection_id=j.connection_id AND e.status='pending' AND e.delivery_order<j.delivery_order) AND NOT EXISTS(SELECT 1 FROM outbox e WHERE e.connection_id=j.connection_id AND e.status='pending' AND e.terminal=0 AND e.delivery_order<j.delivery_order)) ORDER BY j.delivery_order LIMIT 100").all(now).map(row => ({ ...row, body: Buffer.from(row.body) }))
    },
    finishControl(requestId, status, nextAttemptAt = 0, error = null) {
      if (!['delivered', 'pending', 'terminal'].includes(status) || !safeRevision(nextAttemptAt)) fail('invalid_control')
      transaction(() => {
        const job = db.prepare('SELECT owner_id,connection_id FROM integration_controls WHERE request_id=?').get(requestId)
        const result = db.prepare("UPDATE integration_controls SET status=?,attempts=attempts+1,next_attempt_at=?,last_error=?,updated_at=?,delivered_at=CASE WHEN ?='delivered' THEN ? ELSE delivered_at END WHERE request_id=? AND status='pending'").run(status, nextAttemptAt, error, new Date().toISOString(), status, new Date().toISOString(), requestId)
        if (job && result.changes) noteDelivery(job.owner_id, job.connection_id)
      })
    },
    controlReceipt(id, requestId, method, path, body, apply) {
      if (!isUuid(requestId)) fail('invalid_request_id')
      return transaction(() => {
        const previous = db.prepare('SELECT * FROM integration_control_inbox WHERE connection_id=? AND request_id=?').get(id, requestId)
        if (previous) {
          if (previous.method !== method || previous.path !== path || previous.body_hash !== hash(body)) fail('control_conflict')
          return JSON.parse(previous.response)
        }
        const response = apply()
        db.prepare('INSERT INTO integration_control_inbox(connection_id,request_id,method,path,body_hash,response) VALUES(?,?,?,?,?,?)').run(id, requestId, method, path, hash(body), encode(response))
        return response
      })
    },
    nextDeliveryAt() {
      const controls = service.pendingControls(Number.MAX_SAFE_INTEGER).map(row => row.next_attempt_at)
      const events = service.listProfiles().flatMap(owner => service.pending(owner, Number.MAX_SAFE_INTEGER).map(row => row.next_attempt_at))
      const media = service.pendingMedia(Number.MAX_SAFE_INTEGER).map(row => row.next_attempt_at)
      return controls.length + events.length + media.length ? Math.min(...controls, ...events, ...media) : null
    },
    pendingMedia(now = Date.now()) {
      return db.prepare("SELECT m.* FROM integration_media_transfers m JOIN connections c ON c.id=m.connection_id JOIN outbox o ON o.event_id=m.event_id WHERE m.status='pending' AND c.status='active' AND c.paused=0 AND o.status='delivered' AND m.next_attempt_at<=? ORDER BY m.next_attempt_at,m.rowid LIMIT 1").all(now).map(row => ({ ...row, metadata: JSON.parse(row.metadata) }))
    },
    wakeMedia(owner, hash) {
      ownerId(owner)
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail('invalid_media_hash')
      transaction(() => db.prepare("UPDATE integration_media_transfers SET next_attempt_at=0 WHERE owner_id=? AND status='pending' AND json_extract(metadata,'$.sha256')=?").run(owner, hash))
    },
    pendingMediaHashes(owner) {
      ownerId(owner)
      return db.prepare("SELECT metadata FROM integration_media_transfers WHERE owner_id=? AND status='pending'").all(owner).map(row => JSON.parse(row.metadata).sha256)
    },
    finishMedia(requestId, status, nextAttemptAt = 0, error = null) {
      if (!['pending', 'ready', 'terminal'].includes(status) || !safeRevision(nextAttemptAt)) fail('invalid_media_status')
      transaction(() => {
        const job = db.prepare('SELECT owner_id,connection_id FROM integration_media_transfers WHERE request_id=?').get(requestId)
        db.prepare("UPDATE integration_media_transfers SET status=?,attempts=attempts+1,next_attempt_at=?,last_error=?,updated_at=?,delivered_at=CASE WHEN ?='ready' THEN ? ELSE delivered_at END WHERE request_id=?").run(status, nextAttemptAt, error, new Date().toISOString(), status, new Date().toISOString(), requestId)
        if (job) noteDelivery(job.owner_id, job.connection_id)
      })
    },
    terminalEvent(owner, eventId, code) {
      ownerId(owner)
      transaction(() => db.prepare("UPDATE outbox SET terminal=1,last_error=?,updated_at=? WHERE owner_id=? AND event_id=? AND status='pending'").run(code, new Date().toISOString(), owner, eventId))
    },
    getBodyProfile: bodyProfile,
    getBodyArchive(owner) {
      ownerId(owner)
      return db.prepare('SELECT archive_id,connection_id,archived_at,body_values FROM native_body_archive WHERE owner_id=? ORDER BY archive_id').all(owner).map(row => ({ ...row, body_values: JSON.parse(row.body_values) }))
    },
    notifications(owner, after = 0) {
      ownerId(owner)
      if (!safeRevision(after)) fail('invalid_cursor')
      return db.prepare('SELECT cursor,connection_id,kind,payload FROM integration_notifications WHERE owner_id=? AND cursor>? ORDER BY cursor LIMIT 500').all(owner, after).map(row => ({ ...row, payload: JSON.parse(row.payload) }))
    },
    notificationRange(owner) {
      ownerId(owner)
      const row = db.prepare('SELECT COALESCE(MAX(cursor),0) AS latest FROM integration_notifications WHERE owner_id=?').get(owner)
      const metadata = db.prepare('SELECT value FROM storage_metadata WHERE key=?').get('notification_floor:' + owner)
      return { floor: metadata ? JSON.parse(metadata.value) : 0, latest: row.latest }
    },
    compactNotifications(owner, through) {
      ownerId(owner)
      if (!safeRevision(through)) fail('invalid_cursor')
      transaction(() => {
        const range = service.notificationRange(owner)
        if (through > range.latest) fail('invalid_cursor')
        db.prepare('DELETE FROM integration_notifications WHERE owner_id=? AND cursor<=?').run(owner, through)
        db.prepare('INSERT INTO storage_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('notification_floor:' + owner, String(Math.max(range.floor, through)))
      })
    },
    markConflict(owner, id, code) {
      ownerId(owner)
      if (!['source_rewind', 'event_conflict', 'control_conflict', 'snapshot_conflict'].includes(code)) fail('invalid_conflict')
      transaction(() => {
        db.prepare("UPDATE connections SET paused=1 WHERE owner_id=? AND id=? AND status='active'").run(owner, id)
        db.prepare("INSERT INTO integration_notifications(owner_id,connection_id,kind,payload) VALUES(?,?,'integration_conflict',?)").run(owner, id, encode({ code }))
      })
    },
    receiveBody(owner, body) {
      if (!parseEvent(body).resource.startsWith('body_')) fail('direction_denied')
      return service.receiveIncoming(owner, body)
    },
    receiveIncoming(owner, body) {
      const event = parseDomainEvent(body)
      if (!Number.isSafeInteger(event.source_cursor) || event.source_cursor < 1) fail('source_cursor_required')
      return service.receive(owner, body, (_tx, event) => event.resource === 'schedule_summary' ? projectHint(owner, event) : projectBody(owner, event))
    },
    queueNativeSnapshot(owner, id, includeHistory) {
      return snapshotTransaction(() => {
        const connection = connectionFor(owner, id)
        const scopes = JSON.parse(connection.scopes)
        includeHistory ||= !!connection.replaces_connection_id
        if (includeHistory && (!connection.binding || JSON.parse(connection.binding).include_history !== true)) fail('history_not_authorized')
        const original = getProfile(owner)?.state ?? {}
        const failures = []
        const state = normalizeTrainingIdentities(JSON.parse(profileJson(original)), {}, failures)
        const entities = [...exportNativeEntities(state, failures).values()].filter(entity => scopes.includes(entity.resource) && (includeHistory || entity.resource === 'exercise'))
        recordExportFailures(owner, { id, scopes }, failures)
        if (failures.some(value => scopes.includes(value.resource) && (includeHistory || value.resource === 'exercise'))) fail('snapshot_export_blocked')
        if (profileJson(state) !== profileJson(original)) putProfile(owner, state)
        const snapshotId = randomUUID(), start = Number(db.prepare("SELECT value FROM storage_metadata WHERE key='outgoing_source_cursor'").get().value) + 1
        // Empty snapshots still reserve a source boundary, so future snapshots cannot rewind it.
        if (!entities.length) db.prepare("UPDATE storage_metadata SET value=? WHERE key='outgoing_source_cursor'").run(String(start))
        const begin = { version: 1, action: 'begin', connection_id: id, snapshot_id: snapshotId, start_cursor: start, watermark: start + Math.max(1, entities.length) - 1, expected_count: entities.length, membership_sha256: membershipHash(entities), prune_resources: scopes.filter(resource => RESOURCE_PRODUCERS[resource] === 'opengym' && (includeHistory || resource === 'exercise')) }
        insertControl(owner, id, 'POST', '/api/integrations/v1/snapshot', Buffer.from(encode(begin)))
        for (const entity of entities) enqueue(owner, { ...entity, connection_id: id, operation: 'upsert' })
        insertControl(owner, id, 'POST', '/api/integrations/v1/snapshot', Buffer.from(encode({ version: 1, action: 'complete', connection_id: id, snapshot_id: snapshotId })))
        if (connection.replaces_connection_id) db.prepare('UPDATE connections SET replacement_snapshot_id=? WHERE owner_id=? AND id=?').run(snapshotId, owner, id)
        return { version: 1, snapshot_id: snapshotId, status: 'snapshot_queued' }
      })
    },
    queueTwoWaySnapshot(owner, id, includeHistory) {
      return transaction(() => {
        const response = service.queueNativeSnapshot(owner, id, includeHistory)
        insertControl(owner, id, 'POST', '/api/integrations/v1/snapshot', Buffer.from(encode({ version: 1, action: 'request', connection_id: id, include_history: includeHistory })))
        return response
      })
    },
    beginBodySnapshot(owner, id, input) { return service.beginIncomingSnapshot(owner, id, input) },
    beginIncomingSnapshot(owner, id, input) {
      const connection = connectionFor(owner, id)
      validateSnapshot(input, JSON.parse(connection.scopes).filter(resource => RESOURCE_PRODUCERS[resource] === 'sparkyfitness'))
      if (input.prune_resources.includes('body_measurement') && connection.binding && JSON.parse(connection.binding).include_history !== true) fail('history_not_authorized')
      return snapshotTransaction(() => {
        if (input.connection_id !== id) fail('binding_mismatch')
        const source = db.prepare('SELECT source_cursor FROM incoming_sources WHERE owner_id=? AND connection_id=?').get(owner, id)
        const previous = db.prepare('SELECT * FROM incoming_snapshots WHERE snapshot_id=?').get(input.snapshot_id)
        if (!source || !previous && input.start_cursor <= source.source_cursor) fail('source_rewind')
        if (previous) {
          if (previous.owner_id !== owner || previous.connection_id !== id || previous.start_cursor !== input.start_cursor || previous.watermark !== input.watermark || previous.expected_count !== input.expected_count || previous.membership_sha256 !== input.membership_sha256 || previous.prune_resources !== encode(input.prune_resources)) fail('snapshot_conflict')
        } else db.prepare('INSERT INTO incoming_snapshots(snapshot_id,owner_id,connection_id,start_cursor,watermark,expected_count,membership_sha256,prune_resources) VALUES(?,?,?,?,?,?,?,?)').run(input.snapshot_id, owner, id, input.start_cursor, input.watermark, input.expected_count, input.membership_sha256, encode(input.prune_resources))
        return { version: 1, snapshot_id: input.snapshot_id, status: 'snapshot_started' }
      })
    },
    completeBodySnapshot(owner, id, snapshotId) { return service.completeIncomingSnapshot(owner, id, snapshotId) },
    completeIncomingSnapshot(owner, id, snapshotId) {
      return snapshotTransaction(() => {
        const connection = connectionFor(owner, id)
        const snapshot = db.prepare('SELECT * FROM incoming_snapshots WHERE snapshot_id=? AND owner_id=? AND connection_id=?').get(snapshotId, owner, id)
        if (!snapshot) fail('snapshot_unavailable')
        if (snapshot.status === 'complete') return { version: 1, snapshot_id: snapshotId, status: 'snapshot_complete' }
        const members = db.prepare('SELECT resource,entity_id FROM incoming_snapshot_members WHERE snapshot_id=?').all(snapshotId)
        if (members.length !== snapshot.expected_count || membershipHash(members) !== snapshot.membership_sha256) fail('snapshot_incomplete')
        const source = db.prepare('SELECT * FROM incoming_sources WHERE owner_id=? AND connection_id=?').get(owner, id)
        if (!source) fail('incoming_source_unavailable')
        const resources = JSON.parse(snapshot.prune_resources)
        if (resources.includes('body_measurement') && connection.binding && JSON.parse(connection.binding).include_history !== true) fail('history_not_authorized')
        for (const resource of resources) {
          if (resource === 'schedule_summary') {
            db.prepare("DELETE FROM training_hints WHERE owner_id=? AND source_id=? AND last_source_cursor<=? AND NOT EXISTS(SELECT 1 FROM incoming_snapshot_members m WHERE m.snapshot_id=? AND m.resource='schedule_summary' AND m.entity_id=training_hints.entity_id)").run(owner, source.source_id, snapshot.watermark, snapshotId)
            bumpHints(owner, id)
          } else db.prepare('DELETE FROM body_entities WHERE owner_id=? AND source_id=? AND resource=? AND last_source_cursor<=? AND NOT EXISTS(SELECT 1 FROM incoming_snapshot_members m WHERE m.snapshot_id=? AND m.resource=body_entities.resource AND m.entity_id=body_entities.entity_id)').run(owner, source.source_id, resource, snapshot.watermark, snapshotId)
        }
        db.prepare("UPDATE incoming_snapshots SET status='complete' WHERE snapshot_id=?").run(snapshotId)
        db.prepare('UPDATE incoming_sources SET source_cursor=MAX(source_cursor,?) WHERE owner_id=? AND connection_id=?').run(snapshot.watermark, owner, id)
        if (resources.some(resource => resource.startsWith('body_'))) db.prepare('UPDATE body_sources SET revision=revision+1 WHERE owner_id=?').run(owner)
        db.prepare("INSERT INTO integration_notifications(owner_id,connection_id,kind,payload) VALUES(?,?,'snapshot_complete',?)").run(owner, id, encode({ snapshot_id: snapshotId }))
        return { version: 1, snapshot_id: snapshotId, status: 'snapshot_complete' }
      })
    },
    purgeBody(owner, id, confirm) {
      if (confirm !== true) fail('confirmation_required')
      ownerId(owner)
      return transaction(() => {
        const connection = db.prepare("SELECT * FROM connections WHERE owner_id=? AND id=? AND status='revoked'").get(owner, id)
        if (!connection) fail('connection_not_revoked')
        const sourceId = connection.peer_origin + '\n' + connection.peer_user_id
        if (db.prepare("SELECT 1 FROM connections WHERE owner_id=? AND peer_origin=? AND peer_user_id=? AND status!='revoked'").get(owner, connection.peer_origin, connection.peer_user_id)) fail('source_still_connected')
        db.prepare('DELETE FROM body_entities WHERE owner_id=? AND source_id=?').run(owner, sourceId)
        db.prepare('DELETE FROM body_sources WHERE owner_id=? AND source_id=?').run(owner, sourceId)
        db.prepare('DELETE FROM training_hints WHERE owner_id=? AND source_id=?').run(owner, sourceId)
        db.prepare('UPDATE incoming_sources SET connection_id=NULL WHERE owner_id=? AND source_id=?').run(owner, sourceId)
        bumpHints(owner, id)
      })
    },
    getRevision(owner) {
      ownerId(owner)
      return db.prepare('SELECT revision FROM profiles WHERE owner_id=?').get(owner)?.revision ?? null
    },
    listProfiles() {
      return db.prepare('SELECT owner_id FROM profiles ORDER BY owner_id').all().map(row => row.owner_id)
    },
    deleteProfile(owner) {
      ownerId(owner)
      return transaction(() => db.prepare('DELETE FROM profiles WHERE owner_id=?').run(owner).changes > 0)
    },
    getProfileMigration() {
      const row = db.prepare("SELECT value FROM storage_metadata WHERE key='json_profiles_import_v1'").get()
      return row ? JSON.parse(row.value) : null
    },
    importProfiles(profiles, metadata) {
      return transaction(() => {
        if (db.prepare("SELECT 1 FROM storage_metadata WHERE key='json_profiles_import_v1'").get()) fail('migration_already_complete')
        if (db.prepare('SELECT 1 FROM profiles LIMIT 1').get()) fail('migration_target_not_empty')
        const owners = new Set()
        for (const profile of profiles) {
          ownerId(profile.owner_id)
          if (owners.has(profile.owner_id)) fail('duplicate_profile_owner')
          owners.add(profile.owner_id)
          putProfile(profile.owner_id, profile.state)
        }
        db.prepare("INSERT INTO storage_metadata(key,value) VALUES('json_profiles_import_v1',?)").run(encode(metadata))
      })
    },
    completeProfileArchive() {
      transaction(() => {
        const row = db.prepare("SELECT value FROM storage_metadata WHERE key='json_profiles_import_v1'").get()
        if (!row) fail('migration_not_complete')
        const marker = JSON.parse(row.value)
        db.prepare("UPDATE storage_metadata SET value=? WHERE key='json_profiles_import_v1'").run(encode({ ...marker, archive_complete: true }))
      })
    },
    commitProfile(owner, expectedRevision, state, changes = []) {
      if (!safeRevision(expectedRevision) || !Array.isArray(changes)) fail('invalid_commit')
      return transaction(() => {
        if (db.prepare('SELECT 1 FROM body_sources WHERE owner_id=?').get(owner) && hasManagedBodyFields(state)) fail('managed_body_fields')
        const current = getProfile(owner)
        if ((current?.revision ?? 0) !== expectedRevision) fail('profile_conflict')
        const connections = service.listConnections(owner).filter(connection => connection.status === 'active' && connection.binding !== null)
        // Work on validated plain JSON, never a caller's accessors or serialization hooks.
        let next = JSON.parse(profileJson(state)), nativeChanges = []
        if (connections.length) {
          const failures = []
          const prior = normalizeTrainingIdentities(JSON.parse(profileJson(current?.state ?? {})), {}, [])
          next = normalizeTrainingIdentities(next, prior, failures)
          nativeChanges = trainingChanges(prior, next, failures)
          for (const connection of connections) recordExportFailures(owner, connection, failures)
          if (JSON.stringify(next) !== profileJson(state) && Number.isSafeInteger(next._rev)) next._rev++
        }
        const revision = putProfile(owner, next)
        const events = changes.map(change => enqueue(owner, change))
        for (const connection of connections) for (const change of nativeChanges) {
          if (connection.scopes.includes(change.resource)) events.push(enqueue(owner, { ...change, connection_id: connection.id }, true))
        }
        if (events.length) for (const connection of connections) noteDelivery(owner, connection.id)
        return { revision, events }
      })
    },
    createConnection(owner, input, preparation = null) {
      ownerId(owner)
      const url = new URL(input.peer_origin)
      if (!isUuid(input.id) || url.origin !== input.peer_origin ||
        !(url.protocol === 'https:' || url.protocol === 'http:' && input.allow_insecure_http === true) ||
        typeof input.peer_user_id !== 'string' || !input.peer_user_id.length || input.peer_user_id.length > 200 ||
        !Array.isArray(input.scopes) || !input.scopes.length || new Set(input.scopes).size !== input.scopes.length ||
        !Array.from(input.scopes).every(resource => typeof resource === 'string' && Object.hasOwn(RESOURCE_PRODUCERS, resource))) fail('invalid_connection')
      transaction(() => {
        db.prepare("INSERT INTO connections(id,owner_id,peer_origin,allow_insecure_http,peer_user_id,scopes,status) VALUES(?,?,?,?,?,?,'pending')").run(input.id, owner, url.origin, input.allow_insecure_http === true ? 1 : 0, input.peer_user_id, encode(input.scopes))
        if (preparation) {
          db.prepare('UPDATE connections SET binding=?,sealed_keys=?,allow_private_network=? WHERE id=? AND owner_id=?').run(encode(preparation.binding), encode(preparation.sealed_keys), preparation.allow_private_network === true ? 1 : 0, input.id, owner)
          insertControl(owner, input.id, 'POST', '/api/integrations/v1/pair/claim', preparation.body, input.id)
        }
      })
    },
    activateConnection(owner, id, sealedKeys) {
      ownerId(owner)
      if (!sealedKeys || Object.keys(sealedKeys).length !== 3 ||
        !['ciphertext', 'iv', 'tag'].every(key => Object.hasOwn(sealedKeys, key) && typeof sealedKeys[key] === 'string' && sealedKeys[key].length > 0)) fail('sealed_keys_required')
      transaction(() => {
        const result = db.prepare("UPDATE connections SET status='active',sealed_keys=? WHERE owner_id=? AND id=? AND status='pending'").run(encode(sealedKeys), owner, id)
        if (!result.changes) fail('connection_unavailable')
        db.prepare("UPDATE integration_controls SET status='delivered',last_error=NULL,delivered_at=?,updated_at=? WHERE connection_id=? AND path='/api/integrations/v1/pair/claim' AND status IN ('pending','terminal')").run(new Date().toISOString(), new Date().toISOString(), id)
        const connection = db.prepare('SELECT * FROM connections WHERE owner_id=? AND id=?').get(owner, id)
        let replacing = false
        const incomingScopes = JSON.parse(connection.scopes).filter(resource => RESOURCE_PRODUCERS[resource] === 'sparkyfitness')
        if (incomingScopes.length) {
          const sourceId = connection.peer_origin + '\n' + connection.peer_user_id
          const previous = db.prepare('SELECT * FROM incoming_sources WHERE owner_id=? AND connection_id IS NOT NULL').get(owner)
          if (previous) {
            if (!connection.binding || previous.source_id !== sourceId) fail('body_source_exists')
            if (JSON.parse(connection.binding).include_history !== true) fail('rotation_requires_history_approval')
            db.prepare("UPDATE connections SET status='revoked' WHERE owner_id=? AND id=?").run(owner, previous.connection_id)
            db.prepare('UPDATE connections SET replaces_connection_id=? WHERE owner_id=? AND id=?').run(previous.connection_id, owner, id)
            db.prepare('UPDATE incoming_sources SET connection_id=? WHERE owner_id=? AND source_id=?').run(id, owner, sourceId)
            replacing = true
          } else db.prepare('INSERT INTO incoming_sources(owner_id,connection_id,source_id) VALUES(?,?,?) ON CONFLICT(owner_id,source_id) DO UPDATE SET connection_id=excluded.connection_id').run(owner, id, sourceId)
        }
        const priorBinding = db.prepare("SELECT id FROM connections WHERE owner_id=? AND peer_origin=? AND peer_user_id=? AND status='active' AND id!=? ORDER BY rowid DESC LIMIT 1").get(owner, connection.peer_origin, connection.peer_user_id, id)
        if (priorBinding && connection.binding) {
          if (JSON.parse(connection.binding).include_history !== true) fail('rotation_requires_history_approval')
          db.prepare("UPDATE connections SET status='revoked' WHERE owner_id=? AND id=?").run(owner, priorBinding.id)
          db.prepare('UPDATE connections SET replaces_connection_id=? WHERE owner_id=? AND id=?').run(priorBinding.id, owner, id)
          replacing = true
        }
        if (JSON.parse(connection.scopes).some(resource => resource.startsWith('body_'))) {
          const sourceId = connection.peer_origin + '\n' + connection.peer_user_id
          const existing = db.prepare('SELECT * FROM body_sources WHERE owner_id=?').get(owner)
          if (existing) {
            if (!connection.binding || existing.source_id !== sourceId) fail('body_source_exists')
            const old = service.getConnection(owner, existing.connection_id)
            if (!old || old.peer_origin !== connection.peer_origin || old.peer_user_id !== connection.peer_user_id) fail('replacement_identity_mismatch')
            if (JSON.parse(connection.binding).include_history !== true) fail('rotation_requires_history_approval')
            db.prepare("UPDATE connections SET status='revoked' WHERE owner_id=? AND id=?").run(owner, existing.connection_id)
            db.prepare('UPDATE connections SET replaces_connection_id=? WHERE owner_id=? AND id=?').run(existing.connection_id, owner, id)
            db.prepare('UPDATE body_sources SET connection_id=? WHERE owner_id=?').run(id, owner)
            replacing = true
          } else {
            const current = getProfile(owner)
            const archived = Object.fromEntries(MANAGED_BODY_FIELDS.filter(key => Object.hasOwn(current.state, key)).map(key => [key, current.state[key]]))
            db.prepare('INSERT INTO native_body_archive(owner_id,connection_id,archived_at,body_values) VALUES(?,?,?,?)').run(owner, id, new Date().toISOString(), encode(archived))
            if (Object.keys(archived).length) putProfile(owner, stripManagedBodyFields(current.state))
            db.prepare('INSERT INTO body_sources(owner_id,connection_id,source_id) VALUES(?,?,?)').run(owner, id, sourceId)
          }
        }
        if (connection.binding) {
          insertControl(owner, id, 'GET', '/api/integrations/v1/capabilities', Buffer.alloc(0))
          const includeHistory = replacing || JSON.parse(connection.binding).include_history === true
          try {
            const snapshot = service.queueNativeSnapshot(owner, id, includeHistory)
            if (replacing) db.prepare('UPDATE connections SET replacement_snapshot_id=? WHERE owner_id=? AND id=?').run(snapshot.snapshot_id, owner, id)
          } catch (error) { if (error.message !== 'snapshot_export_blocked') throw error }
          insertControl(owner, id, 'POST', '/api/integrations/v1/snapshot', Buffer.from(encode({ version: 1, action: 'request', connection_id: id, include_history: includeHistory })))
          noteDelivery(owner, id)
        }
      })
    },
    revokeConnection(owner, id, controlBody = null) {
      ownerId(owner)
      transaction(() => {
        const existing = service.getConnection(owner, id)
        if (!existing) fail('connection_unavailable')
        if (existing.status === 'revoked') return
        const result = db.prepare("UPDATE connections SET status='revoked' WHERE owner_id=? AND id=?").run(owner, id)
        if (!result.changes) fail('connection_unavailable')
        db.prepare("DELETE FROM integration_media_transfers WHERE owner_id=? AND connection_id=? AND status IN ('pending','terminal')").run(owner, id)
        if (controlBody) {
          const value = JSON.parse(controlBody.toString())
          if (value.version !== 1 || value.connection_id !== id || Object.keys(value).length !== 2) fail('invalid_control')
          insertControl(owner, id, 'POST', '/api/integrations/v1/revoke', controlBody)
        }
        noteDelivery(owner, id)
      })
    },
    clearRevokedKeys(owner, id) {
      transaction(() => db.prepare("UPDATE connections SET sealed_keys=NULL WHERE owner_id=? AND id=? AND status='revoked' AND revocation_receipt=0").run(owner, id))
    },
    receiveRevocation(owner, id, requestId, sealedReceipt) {
      ownerId(owner)
      if (!isUuid(requestId)) fail('invalid_request_id')
      transaction(() => {
        const connection = service.getConnection(owner, id)
        if (!connection) fail('connection_unavailable')
        if (connection.revocation_receipt) return
        db.prepare("DELETE FROM integration_media_transfers WHERE owner_id=? AND connection_id=? AND status IN ('pending','terminal')").run(owner, id)
        db.prepare("UPDATE connections SET status='revoked',sealed_keys=?,revocation_receipt=1 WHERE owner_id=? AND id=?").run(encode(sealedReceipt), owner, id)
        db.prepare("UPDATE integration_controls SET status='delivered',last_error=NULL,delivered_at=?,updated_at=? WHERE owner_id=? AND connection_id=? AND path='/api/integrations/v1/revoke' AND status='pending'").run(new Date().toISOString(), new Date().toISOString(), owner, id)
        db.prepare("INSERT INTO integration_notifications(owner_id,connection_id,kind,payload) VALUES(?,?,'connection_revoked',?)").run(owner, id, encode({ reason: 'peer_revocation_proof', request_id: requestId }))
      })
    },
    confirmReplacementSnapshot(owner, id, snapshotId) {
      transaction(() => {
        const connection = service.getConnection(owner, id)
        if (!connection || connection.replacement_snapshot_id !== snapshotId || !connection.replaces_connection_id) return
        db.prepare("DELETE FROM integration_media_transfers WHERE owner_id=? AND connection_id=? AND status IN ('pending','terminal')").run(owner, connection.replaces_connection_id)
        db.prepare("UPDATE outbox SET terminal=1,last_error='superseded_snapshot' WHERE owner_id=? AND connection_id=? AND status='pending'").run(owner, connection.replaces_connection_id)
        db.prepare("UPDATE connections SET sealed_keys=NULL WHERE owner_id=? AND id=? AND status='revoked' AND revocation_receipt=0").run(owner, connection.replaces_connection_id)
      })
    },
    receive(owner, body, apply) {
      const event = Object.freeze(parseEvent(body))
      if (event.producer !== 'sparkyfitness') fail('direction_denied')
      if (typeof apply !== 'function' || apply.constructor.name === 'AsyncFunction') fail('synchronous_required')
      return transaction(() => {
        connectionFor(owner, event.connection_id, event.resource)
        const stream = streamFor(owner, event)
        const prior = db.prepare('SELECT body_hash FROM inbox WHERE connection_id=? AND event_id=?').get(event.connection_id, event.event_id)
        const digest = hash(body)
        if (prior) {
          if (prior.body_hash !== digest) fail('event_conflict')
          recordMembership(owner, event)
          return { version: 1, event_id: event.event_id, status: 'duplicate', revision: stream.incoming_revision }
        }
        if (Object.hasOwn(event, 'source_cursor')) {
          const source = db.prepare('SELECT source_cursor FROM incoming_sources WHERE owner_id=? AND connection_id=?').get(owner, event.connection_id)
          const snapshot = db.prepare("SELECT 1 FROM incoming_snapshots WHERE owner_id=? AND connection_id=? AND status='open' AND start_cursor<=? AND watermark>=?").get(owner, event.connection_id, event.source_cursor, event.source_cursor)
          if (source && event.source_cursor <= source.source_cursor && !snapshot) fail('source_rewind')
        }
        if (event.revision === stream.incoming_revision) fail('event_conflict')
        const stale = event.revision < stream.incoming_revision
        recordMembership(owner, event)
        if (!stale) {
          let active = true
          const guard = () => { if (!active) fail('transaction_closed') }
          const tx = Object.freeze({
            getProfile() { guard(); return getProfile(owner) },
            putProfile(state) { guard(); return putProfile(owner, state) },
          })
          try {
            const result = apply(tx, event)
            if (result && typeof result.then === 'function') {
              // Observe rejections without permitting asynchronous transaction work.
              Promise.resolve(result).catch(() => {})
              fail('synchronous_required')
            }
          } finally { active = false }
          db.prepare('UPDATE streams SET incoming_revision=? WHERE connection_id=? AND resource=? AND entity_id=?').run(event.revision, event.connection_id, event.resource, event.entity_id)
        }
        if (Object.hasOwn(event, 'source_cursor')) db.prepare('UPDATE incoming_sources SET source_cursor=MAX(source_cursor,?) WHERE owner_id=? AND connection_id=?').run(event.source_cursor, owner, event.connection_id)
        const receipt = { version: 1, event_id: event.event_id, status: stale ? 'stale' : 'applied', revision: stale ? stream.incoming_revision : event.revision }
        db.prepare('INSERT INTO inbox(event_id,connection_id,owner_id,body_hash,receipt) VALUES(?,?,?,?,?)').run(event.event_id, event.connection_id, owner, digest, encode(receipt))
        return receipt
      })
    },
    pending(owner, now = Date.now()) {
      ownerId(owner)
      if (!safeRevision(now)) fail('invalid_time')
      const rows = db.prepare("SELECT o.event_id,o.connection_id,o.body,o.attempts,o.next_attempt_at FROM outbox o JOIN connections c ON o.connection_id=c.id AND o.owner_id=c.owner_id WHERE o.owner_id=? AND o.status='pending' AND o.terminal=0 AND c.status='active' AND c.paused=0 AND o.next_attempt_at<=? AND NOT EXISTS(SELECT 1 FROM outbox earlier WHERE earlier.connection_id=o.connection_id AND earlier.status='pending' AND earlier.terminal=0 AND earlier.source_cursor<o.source_cursor) AND NOT EXISTS(SELECT 1 FROM integration_controls e WHERE e.connection_id=o.connection_id AND e.status='pending' AND e.delivery_order<o.delivery_order) ORDER BY o.source_cursor LIMIT 100").all(owner, now)
      return rows.map(row => ({ ...row, body: Buffer.from(row.body) }))
    },
    retry(owner, eventId, nextAttemptAt, code) {
      if (!safeRevision(nextAttemptAt) || typeof code !== 'string' || !/^[a-z_]{1,64}$/.test(code)) fail('invalid_retry')
      transaction(() => {
        const row = outboxFor(owner, eventId)
        connectionFor(owner, row.connection_id)
        if (row.status !== 'pending') fail('event_not_pending')
        db.prepare('UPDATE outbox SET attempts=attempts+1,next_attempt_at=?,last_error=?,updated_at=? WHERE owner_id=? AND event_id=?').run(nextAttemptAt, code, new Date().toISOString(), owner, eventId)
        noteDelivery(owner, row.connection_id)
      })
    },
    acknowledge(owner, eventId, input) {
      const receipt = parseReceipt(input)
      transaction(() => {
        const row = outboxFor(owner, eventId)
        connectionFor(owner, row.connection_id)
        if (receipt.event_id.toLowerCase() !== row.event_id.toLowerCase() || receipt.revision < row.revision ||
          receipt.status === 'applied' && receipt.revision !== row.revision) fail('invalid_receipt')
        db.prepare("UPDATE outbox SET status='delivered',receipt=?,last_error=NULL,delivered_at=?,updated_at=? WHERE owner_id=? AND event_id=?").run(encode(receipt), new Date().toISOString(), new Date().toISOString(), owner, eventId)
        noteDelivery(owner, row.connection_id)
      })
    },
    close() {
      if (closed) return
      if (inTransaction) fail('transaction_active')
      db.close()
      closed = true
    },
  }
  return Object.freeze(service)
}
