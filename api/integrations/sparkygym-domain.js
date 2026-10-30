import { parseEvent } from './sparkygym-protocol.js'
import { validateBodyPayload } from './sparkygym-body-validation.js'
import { PERSONAL_MEDIA_MIMES, isWellFormedText } from './sparkygym-media.js'
import { validateHintPayload } from './training-hints-model.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
const text = (value, max = 300, min = 1) => isWellFormedText(value) && value.length >= min && value.length <= max
function wellFormedJson(value) {
  const pending = [value], seen = new Set()
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') { if (!isWellFormedText(item)) return false }
    else if (item && typeof item === 'object') {
      if (seen.has(item)) return false
      seen.add(item)
      for (const [key, child] of Object.entries(item)) { if (!isWellFormedText(key)) return false; pending.push(child) }
    }
  }
  return true
}
const identifier = value => text(value, 200) && !/[\x00-\x1f\x7f]/.test(value)
const quantity = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const nullable = (value, validator) => value === null || validator(value)
const integer = value => quantity(value) && Number.isInteger(value)
const position = value => integer(value) && value <= 10000
const array = (value, max, validator) => Array.isArray(value) && value.length <= max && value.every(validator)
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
function timezone(value) { if (!text(value, 100) || /^[+-]/.test(value)) return false; try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false } }
function nativeJson(value) {
  if (!object(value) || value.version !== 1) return false
  const pending = [{ value, depth: 0 }], seen = new Set()
  let nodes = 0, size = 0
  while (pending.length) {
    const { value, depth } = pending.pop()
    if (++nodes > 10000 || depth > 16) return false
    if (value === null || typeof value === 'boolean') continue
    if (typeof value === 'number') { if (!Number.isFinite(value)) return false; continue }
    if (typeof value === 'string') { size += value.length; if (!isWellFormedText(value) || value.length > 10000) return false; continue }
    if (typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
    for (const [key, child] of Object.entries(value)) { size += key.length; if (key.length > 200 || /^(?:user_?id|owner_?id)$/i.test(key)) return false; pending.push({ value: child, depth: depth + 1 }) }
    if (size > 131072) return false
  }
  return size <= 131072
}
const set = value => exact(value, ['set_id', 'position', 'kind', 'completed', 'reps', 'weight_kg', 'duration_seconds', 'distance_meters', 'rpe', 'rir', 'load_mode', 'superset_group', 'topology']) && identifier(value.set_id) && position(value.position) && identifier(value.kind) && typeof value.completed === 'boolean' && nullable(value.reps, integer) && ['weight_kg', 'duration_seconds', 'distance_meters', 'rir'].every(key => nullable(value[key], quantity)) && nullable(value.rpe, number => quantity(number) && number <= 10) && nullable(value.load_mode, identifier) && nullable(value.superset_group, identifier) && nativeJson(value.topology)
const exerciseInstance = value => exact(value, ['instance_id', 'exercise_id', 'name', 'position', 'sets', 'source_snapshot']) && identifier(value.instance_id) && identifier(value.exercise_id) && text(value.name) && position(value.position) && array(value.sets, 1000, set) && nativeJson(value.source_snapshot)
export function validateDomainPayload(resource, value) {
  if (!wellFormedJson(value)) throw new TypeError('invalid_domain_payload')
  if (resource.startsWith('body_')) return validateBodyPayload(resource, value)
  let valid = false
  if (resource === 'exercise') valid = exact(value, ['exercise_id', 'name', 'category', 'equipment', 'primary_muscles', 'secondary_muscles', 'aliases', 'notes']) && identifier(value.exercise_id) && text(value.name) && text(value.category) && ['equipment', 'primary_muscles', 'secondary_muscles', 'aliases'].every(key => array(value[key], 100, item => text(item))) && text(value.notes, 10000, 0)
  if (resource === 'workout') valid = exact(value, ['workout_id', 'name', 'date', 'timezone', 'started_at', 'ended_at', 'duration_seconds', 'calories_kcal', 'body_weight_kg', 'target_weight_kg', 'exercises', 'source_snapshot']) && identifier(value.workout_id) && text(value.name) && day(value.date) && timezone(value.timezone) && nullable(value.started_at, timestamp) && nullable(value.ended_at, timestamp) && (value.started_at === null || value.ended_at === null || value.started_at <= value.ended_at) && ['duration_seconds', 'calories_kcal', 'body_weight_kg', 'target_weight_kg'].every(key => nullable(value[key], quantity)) && array(value.exercises, 500, exerciseInstance) && nativeJson(value.source_snapshot)
  if (resource === 'schedule_summary') return validateHintPayload(value)
  if (resource === 'personal_media') valid = exact(value, ['media_id', 'sha256', 'bytes', 'mime', 'kind', 'workout_id', 'date', 'caption']) && identifier(value.media_id) && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) && integer(value.bytes) && value.bytes > 0 && value.bytes <= 104857600 && PERSONAL_MEDIA_MIMES.includes(value.mime) && ['workout', 'progress'].includes(value.kind) && nullable(value.workout_id, identifier) && day(value.date) && text(value.caption, 4000, 0)
  if (!valid) throw new TypeError('invalid_domain_payload')
  return value
}
export function parseDomainEvent(body) {
  const event = parseEvent(body)
  if (!wellFormedJson(event)) throw new TypeError('invalid_domain_payload')
  if (!Number.isSafeInteger(event.source_cursor) || event.source_cursor < 1) throw new TypeError('source_cursor_required')
  if (event.operation === 'upsert') validateDomainPayload(event.resource, event.payload)
  return event
}
