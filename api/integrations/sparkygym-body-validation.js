import { isWellFormedText } from './sparkygym-media.js'
const units = { mass: 'kg', length: 'cm', percent: 'percent', number: 'none', text: 'text' }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const metric = value => typeof value === 'string' && (/^[a-z][a-z0-9_]{0,99}$/.test(value) || /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00.000Z')) && new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) === value
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const definition = value => object(value) && isWellFormedText(value.label) && value.label.length > 0 && value.label.length <= 300 && Object.hasOwn(units, value.value_type) && typeof value.builtin === 'boolean'
export function validateBodyPayload(resource, value) {
  let valid = false
  if (resource === 'body_definition') valid = exact(value, ['metric_id', 'label', 'value_type', 'unit', 'builtin', 'enabled']) && metric(value.metric_id) && definition(value) && units[value.value_type] === value.unit && typeof value.enabled === 'boolean'
  if (resource === 'body_goal') valid = exact(value, ['metric_id', 'value', 'unit', 'effective_date']) && value.metric_id === 'target_weight' && Number.isFinite(value.value) && value.value > 0 && value.unit === 'kg' && (value.effective_date === null || day(value.effective_date))
  if (resource === 'body_measurement') {
    valid = exact(value, ['metric_id', 'date', 'value', 'unit', 'measured_at', 'timezone', 'definition']) && metric(value.metric_id) && day(value.date) && exact(value.definition, ['label', 'value_type', 'builtin']) && definition(value.definition) && units[value.definition.value_type] === value.unit && (value.measured_at === null || timestamp(value.measured_at)) && typeof value.timezone === 'string' && value.timezone.length > 0 && value.timezone.length <= 100 && !/^[+-]/.test(value.timezone)
    if (valid) {
      try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }) } catch { valid = false }
      valid &&= value.definition.value_type === 'text' ? isWellFormedText(value.value) && value.value.length <= 4000 : typeof value.value === 'number' && Number.isFinite(value.value) && (value.definition.value_type === 'number' || value.value >= 0)
    }
  }
  if (!valid) throw new TypeError('invalid_body_payload')
  return value
}
