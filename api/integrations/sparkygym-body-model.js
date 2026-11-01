// Browser-safe domain composition. Source-only metrics retain their own names.
export const MANAGED_BODY_FIELDS = Object.freeze(['bodyweight', 'measurements', 'customMeasurements', 'measurementEnabled', 'targetW'])
const nativeFields = Object.freeze({ neck: 'neck', shoulders: 'shoulders', chest: 'chest', waist: 'waist', hips: 'hips', abdomen: 'abdomen', upper_arm_left: 'upperArmLeft', upper_arm_right: 'upperArmRight', forearm_left: 'forearmLeft', forearm_right: 'forearmRight', wrist_left: 'wristLeft', wrist_right: 'wristRight', thigh_left: 'thighLeft', thigh_right: 'thighRight', calf_left: 'calfLeft', calf_right: 'calfRight', ankle_left: 'ankleLeft', ankle_right: 'ankleRight', body_fat_percentage: 'bodyFat' })
// SF retains its persisted metric IDs; aliases affect presentation, never source identity.
const sfCircumferenceAliases = Object.freeze({
  left_biceps: 'upperArmLeft', right_biceps: 'upperArmRight',
  left_forearm: 'forearmLeft', right_forearm: 'forearmRight',
  left_wrist: 'wristLeft', right_wrist: 'wristRight',
  left_thigh: 'thighLeft', right_thigh: 'thighRight',
  left_calf: 'calfLeft', right_calf: 'calfRight',
  left_ankle: 'ankleLeft', right_ankle: 'ankleRight'
})
const displayUnit = unit => unit === 'percent' ? '%' : unit
const nativeField = reading => {
  if (!reading.definition?.builtin || !((reading.unit === 'cm' && reading.definition.value_type === 'length') || (reading.unit === 'percent' && reading.definition.value_type === 'percent'))) return null
  if (Object.hasOwn(nativeFields, reading.metric_id)) return nativeFields[reading.metric_id]
  return reading.unit === 'cm' && Object.hasOwn(sfCircumferenceAliases, reading.metric_id) ? sfCircumferenceAliases[reading.metric_id] : null
}
export function stripManagedBodyFields(state) {
  return Object.fromEntries(Object.entries(state).filter(([key]) => !MANAGED_BODY_FIELDS.includes(key)))
}
export function hasManagedBodyFields(state) {
  return MANAGED_BODY_FIELDS.some(key => Object.hasOwn(state, key))
}
export function composeBodyState(state, body) {
  if (body?.managed === false) return state
  if (body?.managed !== true) return { ...stripManagedBodyFields(state), bodyweight: [], measurements: [], customMeasurements: [], measurementEnabled: null, targetW: null }
  const days = new Map(), weights = [], definitions = new Map(body.definitions.map(value => [value.metric_id, value]))
  const readings = [...body.measurements].sort((a, b) => (a.measured_at || '').localeCompare(b.measured_at || '') || a.entity_id.localeCompare(b.entity_id))
  const weightDays = new Map()
  for (const reading of readings) {
    if (reading.metric_id === 'weight' && reading.unit === 'kg' && typeof reading.value === 'number') {
      weightDays.set(reading.date, { id: reading.entity_id, d: reading.date, w: reading.value })
      continue
    }
    let day = days.get(reading.date)
    if (!day) { day = { id: 'sparkyfitness:' + reading.date, d: reading.date, other: [], sourceMetrics: {}, sourceDefinitions: {} }; days.set(reading.date, day) }
    day.sourceMetrics[reading.metric_id] = reading.value
    day.sourceDefinitions[reading.metric_id] = { ...reading.definition, unit: reading.unit }
    const field = nativeField(reading)
    if (field) day[field] = reading.value
    else {
      const value = { id: reading.metric_id, name: reading.definition.label, value: reading.value, unit: displayUnit(reading.unit), value_type: reading.definition.value_type }
      const prior = day.other.findIndex(item => item.id === reading.metric_id)
      if (prior < 0) day.other.push(value); else day.other[prior] = value
      if (!definitions.has(reading.metric_id)) definitions.set(reading.metric_id, { metric_id: reading.metric_id, ...reading.definition, unit: reading.unit, enabled: true })
    }
  }
  weights.push(...weightDays.values())
  const factor = state.unit === 'lb' ? 1 / 0.45359237 : 1
  const customMeasurements = [...definitions.values()].filter(value => !nativeField({ metric_id: value.metric_id, unit: value.unit, definition: value }) && value.metric_id !== 'weight').map(value => ({ id: value.metric_id, name: value.label, unit: displayUnit(value.unit), value_type: value.value_type, enabled: value.enabled }))
  return { ...stripManagedBodyFields(state), bodyweight: weights.map(row => ({ ...row, w: row.w * factor })).sort((a, b) => a.d.localeCompare(b.d)), measurements: [...days.values()].sort((a, b) => a.d.localeCompare(b.d)), customMeasurements, measurementEnabled: null, targetW: body.target ? body.target.value * factor : null }
}
