import { randomUUID, createHash } from 'node:crypto'
import { LIB_BY_ID } from '../coach/core/library.js'
import { isBw } from '../coach/core/payload.js'
import { validateDomainPayload } from './sparkygym-domain.js'
import { PERSONAL_MEDIA_MIMES, isWellFormedText } from './sparkygym-media.js'

const fail = () => { throw new TypeError('invalid_export') }
const id = value => isWellFormedText(value) && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value)
const num = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const list = value => Array.isArray(value) ? value : []
const timestamp = value => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value
function nativeSnapshot(value) {
  let nodes = 0, size = 0
  function visit(item, depth) {
    if (++nodes > 10000 || depth > 16) fail()
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); return item }
    if (typeof item === 'string') { size += item.length; if (!isWellFormedText(item) || item.length > 10000 || size > 131072) fail(); return item }
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1))
    if (!item || typeof item !== 'object') fail()
    const output = {}
    for (const [key, child] of Object.entries(item)) {
      // Transport-independent native fields only; files travel through the media domain.
      if (['media', 'photos', 'image', 'imageUrl', 'image_url', 'animation', 'animationUrl', 'animation_url', 'url', '_ts', '_prior', '_unstamped'].includes(key) || /^(?:user_?id|owner_?id)$/i.test(key)) continue
      size += key.length
      if (!isWellFormedText(key) || key.length > 200 || size > 131072) fail()
      Object.defineProperty(output, key, { value: visit(child, depth + 1), enumerable: true, configurable: true, writable: true })
    }
    return output
  }
  return { ...visit(value, 0), version: 1 }
}
const comparable = value => JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => !['set_id', 'instance_id', '_ts', '_prior'].includes(key))))
function assignIds(records, previous, field, match) {
  const used = new Set()
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail()
    if (typeof record[field] === 'string' && !isWellFormedText(record[field])) fail()
    if (!id(record[field])) {
      const candidates = previous.filter(old => !used.has(old[field]) && match(old, record))
      if (candidates.length === 1 && id(candidates[0][field])) record[field] = candidates[0][field]
      else record[field] = randomUUID()
    }
    if (used.has(record[field])) fail()
    used.add(record[field])
  }
}
export function normalizeTrainingIdentities(state, previous = {}, failures = null) {
  const currentCustomIds = new Set(list(state.customEx).map(value => value?.id))
  const removedCustomIds = list(previous.customEx).map(value => value?.id).filter(value => id(value) && !currentCustomIds.has(value))
  if (removedCustomIds.length) {
    const deleted = state.deleted && typeof state.deleted === 'object' && !Array.isArray(state.deleted) ? state.deleted : {}
    const customs = deleted.customEx && typeof deleted.customEx === 'object' && !Array.isArray(deleted.customEx) ? deleted.customEx : {}
    state.deleted = { ...deleted, customEx: { ...customs, ...Object.fromEntries(removedCustomIds.map(value => [value, customs[value] || Date.now()])) } }
  }
  for (const workout of list(state.workouts)) {
    if (!id(workout?.id)) continue
    const old = list(previous.workouts).find(item => item?.id === workout.id)
    const entries = list(workout.entries)
    try {
      assignIds(entries, list(old?.entries), 'instance_id', (a, b) => a.id === b.id && comparable(a) === comparable(b))
      for (const entry of entries) {
        const oldEntry = list(old?.entries).find(item => item.instance_id === entry.instance_id)
        assignIds(list(entry.sets), list(oldEntry?.sets), 'set_id', (a, b) => comparable(a) === comparable(b))
      }
    } catch (error) { if (!(error instanceof TypeError) || error.message !== 'invalid_export') throw error }
  }
  return state
}
export function exportNativeEntities(state, failures = null) {
  const entities = new Map(), factor = state.unit === 'lb' ? 0.45359237 : 1
  const attempt = (resource, entity, fn) => {
    try { fn() } catch (error) {
      if (!failures || !(error instanceof TypeError) || !['invalid_export', 'invalid_domain_payload', 'invalid_week', 'schedule_incomplete', 'schedule_wire_limit'].includes(error.message)) throw error
      const entityId = id(entity?.id) ? entity.id : 'invalid:' + createHash('sha256').update(JSON.stringify(entity) ?? 'null').digest('hex')
      failures.push({ resource, entity_id: entityId, code: ['schedule_incomplete', 'schedule_wire_limit'].includes(error.message) ? error.message : 'invalid_domain_payload' })
    }
  }
  const publish = (resource, entityId, payload) => { validateDomainPayload(resource, payload); entities.set(resource + '\n' + entityId, { resource, entity_id: entityId, payload }) }
  const kg = value => num(value) === null ? null : value * factor
  const customs = new Map(list(state.customEx).filter(item => item?.id).map(item => [item.id, item]))
  const exercise = (exerciseId, entry = {}) => {
    if (!id(exerciseId)) fail()
    const custom = customs.get(exerciseId), known = custom || LIB_BY_ID.get(exerciseId)
    const names = values => list(values).filter(value => typeof value === 'string' && value.length > 0).slice(0, 100).map(value => value.slice(0, 300))
    const primary = names(known?.primaries || entry.muscleSnapshot?.primaries)
    const value = { exercise_id: exerciseId, name: String(known?.n || entry.muscleSnapshot?.n || entry.name || exerciseId).slice(0, 300), category: String(known?.bp || entry.muscleSnapshot?.bp || 'other').slice(0, 300), equipment: known?.eq ? [String(known.eq).slice(0, 300)] : [], primary_muscles: primary.length ? primary : known?.tg ? [String(known.tg).slice(0, 300)] : [], secondary_muscles: names(known?.secondaries || entry.muscleSnapshot?.secondaries), aliases: names(state.exAliases?.[exerciseId]), notes: String(custom?.desc || '').slice(0, 10000) }
    if (custom || !state.deleted?.customEx?.[exerciseId]) publish('exercise', exerciseId, value)
    return value
  }
  for (const custom of customs.values()) attempt('exercise', custom, () => exercise(custom.id))
  for (const workout of list(state.workouts)) {
    attempt('workout', workout, () => {
    if (!workout || !id(workout.id) || !day(workout.d)) fail()
    if (workout.entries != null && !Array.isArray(workout.entries)) fail()
    const timezone = workout.timezone || state.timezone || 'UTC'
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { fail() }
    const started = timestamp(workout.start), ended = timestamp(workout.end)
    if (started && ended && started > ended) fail()
    const payload = { workout_id: workout.id, name: String(workout.name || 'Workout').slice(0, 300), date: workout.d, timezone,
      started_at: started, ended_at: ended, duration_seconds: started && ended ? (workout.end - workout.start) / 1000 : null,
      calories_kcal: num(workout.calories), body_weight_kg: kg(workout.bw), target_weight_kg: kg(workout.targetW),
      exercises: list(workout.entries).map((entry, position) => {
        if (!entry || !id(entry.id) || entry.sets != null && !Array.isArray(entry.sets)) fail()
        const info = exercise(entry.id, entry)
        const known = customs.get(entry.id) || LIB_BY_ID.get(entry.id)
        const loadMode = entry.target?.assisted === true || known?.assisted === true ? 'assisted' : entry.target?.dbLoad || (isBw(entry.target, known) ? 'bodyweight_added' : null)
        if (!id(entry.instance_id)) fail()
        return { instance_id: entry.instance_id, exercise_id: entry.id, name: info.name, position, sets: list(entry.sets).map((set, position) => {
          if (!set || !id(set.set_id)) fail()
          return { set_id: set.set_id, position, kind: String(set.phase || (set.failure ? 'failure' : 'working')), completed: set.done === true,
            reps: Number.isInteger(set.r) ? num(set.r) : null, weight_kg: kg(set.w), duration_seconds: num(set.sec) ?? (num(set.min) === null ? null : set.min * 60),
            distance_meters: num(set.distance_meters) ?? (num(set.speed) !== null && num(set.min) !== null ? set.speed * set.min * 1000 / 60 : null), rpe: num(set.rpe), rir: num(set.rir), load_mode: loadMode, superset_group: entry.sg || null,
            topology: nativeSnapshot(set) }
        }), source_snapshot: nativeSnapshot(entry) }
      }), source_snapshot: nativeSnapshot(workout) }
    publish('workout', workout.id, payload)
    })
    for (const media of list(workout?.media)) {
      const mediaId = 'workout-media:' + createHash('sha256').update(String(workout.id) + '\0' + String(media?.hash)).digest('hex')
      attempt('personal_media', { id: mediaId }, () => {
      if (!/^[a-f0-9]{64}$/.test(media?.hash) || !Number.isSafeInteger(media.size) || media.size <= 0 || media.size > 104_857_600 || !PERSONAL_MEDIA_MIMES.includes(media.mime)) fail()
      if (!id(mediaId)) fail()
      publish('personal_media', mediaId, { media_id: mediaId, sha256: media.hash, bytes: media.size, mime: media.mime, kind: 'workout', workout_id: workout.id, date: workout.d, caption: String(media.caption || '').slice(0, 4000) })
      })
    }
  }
  if (state.dayPhotos && typeof state.dayPhotos === 'object' && !Array.isArray(state.dayPhotos)) for (const [hash, entry] of Object.entries(state.dayPhotos)) {
    if (!entry?.m) continue
    const mediaId = 'progress-media:' + hash
    attempt('personal_media', { id: mediaId }, () => {
      const media = entry.m
      if (!/^[a-f0-9]{64}$/.test(hash) || media.hash !== hash) fail()
      publish('personal_media', mediaId, { media_id: mediaId, sha256: hash, bytes: media.size, mime: media.mime, kind: 'progress', workout_id: null, date: entry.d, caption: String(media.caption || '').slice(0, 4000) })
    })
  }
  return entities
}
export function trainingChanges(previous, next, failures = null) {
  const previousFailures = [], before = exportNativeEntities(previous, previousFailures), afterFailures = failures || [], after = exportNativeEntities(next, afterFailures), changes = []
  if (!failures && afterFailures.length) fail()
  const unavailable = new Set(afterFailures.map(value => value.resource + '\n' + value.entity_id))
  for (const [key, entity] of after) if (JSON.stringify(before.get(key)?.payload) !== JSON.stringify(entity.payload)) changes.push({ ...entity, operation: 'upsert' })
  const previousEntities = new Map([...before, ...previousFailures.map(value => [value.resource + '\n' + value.entity_id, value])])
  for (const [key, entity] of previousEntities) if (!after.has(key) && !unavailable.has(key) && !entity.entity_id.startsWith('invalid:')) changes.push({ resource: entity.resource, entity_id: entity.entity_id, operation: 'delete', payload: null })
  return changes
}
