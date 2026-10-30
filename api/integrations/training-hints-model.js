// Runtime-neutral wire/read model shared by the native API and offline client.
export const TIME_SLOTS = ['morning', 'noon', 'afternoon', 'evening']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
export const calendarDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value
export const weekdayForDate = date => new Date(date + 'T12:00:00Z').getUTCDay()
export function validateHintPayload(value) {
  let valid = exact(value, ['name', 'timezone', 'week_start', 'effective_from', 'effective_until', 'days']) && text(value.name) && typeof value.timezone === 'string' && value.timezone.length <= 100 && !/^[+-]/.test(value.timezone) && Number.isInteger(value.week_start) && value.week_start >= 0 && value.week_start <= 6 && calendarDay(value.effective_from) && (value.effective_until === null || calendarDay(value.effective_until) && value.effective_until >= value.effective_from) && Array.isArray(value.days) && value.days.length <= 7
  if (valid) { try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }) } catch { valid = false } }
  if (valid) valid = new Set(value.days.map(d => d?.weekday)).size === value.days.length && value.days.every(d => exact(d, ['weekday', 'slots']) && Number.isInteger(d.weekday) && d.weekday >= 0 && d.weekday <= 6 && Array.isArray(d.slots) && d.slots.length <= 4 && new Set(d.slots.map(s => s?.time_slot)).size === d.slots.length && (!d.slots.length || d.slots.filter(s => s?.is_main === true).length === 1) && d.slots.every(s => exact(s, ['time_slot', 'activity', 'is_main']) && TIME_SLOTS.includes(s.time_slot) && text(s.activity) && typeof s.is_main === 'boolean'))
  if (!valid) throw new TypeError('invalid_domain_payload')
  return value
}
export function validateHintsResponse(value) {
  if (!exact(value, ['revision', 'date', 'hints']) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !(value.date === null || calendarDay(value.date)) || !Array.isArray(value.hints)) return false
  const ids = new Set()
  try {
    for (const hint of value.hints) {
      if (!object(hint) || typeof hint.entity_id !== 'string' || !hint.entity_id.length || hint.entity_id.length > 200 || ids.has(hint.entity_id)) return false
      ids.add(hint.entity_id)
      const { entity_id: _id, ...payload } = hint
      validateHintPayload(payload)
      if (value.date !== null && (value.date < payload.effective_from || payload.effective_until && value.date > payload.effective_until)) return false
    }
    return true
  } catch { return false }
}
