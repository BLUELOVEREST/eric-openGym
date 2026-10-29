import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const MAX_BYTES = 1_048_576
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/
const TIMESTAMP = /^(0|[1-9]\d{0,15})$/
const SIGNATURE = /^v1=[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FIELDS = ['version', 'event_id', 'connection_id', 'producer', 'resource', 'entity_id', 'revision', 'operation', 'occurred_at', 'payload']
const BODY_RESOURCES = ['body_measurement', 'body_goal']
const TRAINING_RESOURCES = ['exercise', 'workout', 'schedule_summary', 'personal_media']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function checkBody(body) {
  if (!Buffer.isBuffer(body) || body.length > MAX_BYTES) throw new TypeError('Invalid event body')
}

function finiteJson(value) {
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(finiteJson)
  return !object(value) || Object.values(value).every(finiteJson)
}

export function parseEvent(body) {
  checkBody(body)
  const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  const timestamp = typeof event?.occurred_at === 'string' ? new Date(event.occurred_at) : new Date(NaN)
  if (!object(event) || Object.keys(event).length !== FIELDS.length ||
    !FIELDS.every(key => Object.hasOwn(event, key)) || event.version !== 1 ||
    typeof event.event_id !== 'string' || !UUID.test(event.event_id) ||
    typeof event.connection_id !== 'string' || !UUID.test(event.connection_id) ||
    typeof event.entity_id !== 'string' || event.entity_id.length < 1 || event.entity_id.length > 200 ||
    /[\x00-\x1f\x7f]/.test(event.entity_id) || !Number.isSafeInteger(event.revision) || event.revision < 1 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.occurred_at) ||
    !Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== event.occurred_at ||
    !['upsert', 'delete'].includes(event.operation) ||
    (event.operation === 'delete' ? event.payload !== null : !object(event.payload)) || !finiteJson(event.payload) ||
    !(event.producer === 'sparkyfitness' && BODY_RESOURCES.includes(event.resource) ||
      event.producer === 'opengym' && TRAINING_RESOURCES.includes(event.resource))) {
    throw new TypeError('Invalid event envelope')
  }
  return event
}

export function parseReceipt(value) {
  if (!object(value) || Object.keys(value).length !== 4 || value.version !== 1 ||
    typeof value.event_id !== 'string' || !UUID.test(value.event_id) ||
    !['applied', 'duplicate', 'stale'].includes(value.status) ||
    !Number.isSafeInteger(value.revision) || value.revision < 1) throw new TypeError('Invalid event receipt')
  return value
}

const validTimestamp = value => typeof value === 'string' && TIMESTAMP.test(value) && Number.isSafeInteger(Number(value))

export function signRequest(body, keyId, timestamp, secret) {
  checkBody(body)
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId) || !validTimestamp(timestamp) ||
    !Buffer.isBuffer(secret) || secret.length !== 32) throw new TypeError('Invalid signing inputs')
  const digest = createHash('sha256').update(body).digest('hex')
  const canonical = ['sparkygym-v1', 'POST', '/api/integrations/v1/events', timestamp, keyId, digest].join('\n')
  return `v1=${createHmac('sha256', secret).update(canonical).digest('hex')}`
}

// Valid signatures still need connection/scope/replay checks at the receiver boundary.
export function verifyRequest(body, keyId, timestamp, signature, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof signature !== 'string' || !SIGNATURE.test(signature) || !validTimestamp(timestamp) ||
    !Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || Math.abs(nowSeconds - Number(timestamp)) > 300) return false
  try {
    const expected = signRequest(body, keyId, timestamp, secret)
    return timingSafeEqual(Buffer.from(signature.slice(3), 'hex'), Buffer.from(expected.slice(3), 'hex'))
  } catch { return false }
}
