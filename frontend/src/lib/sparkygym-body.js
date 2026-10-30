import { composeBodyState, stripManagedBodyFields, MANAGED_BODY_FIELDS } from '../../../api/integrations/sparkygym-body-model.js'

export { MANAGED_BODY_FIELDS }
export const bodyView = composeBodyState
export const bodyWriteState = (state, body) => body?.managed === false ? state : stripManagedBodyFields(state)

// A transport/proxy failure must never turn source-owned data into a writable local profile.
export function validateBodyProfile(value) {
  return !!value && typeof value === 'object' && typeof value.managed === 'boolean' &&
    (value.source === null || value.source === 'sparkyfitness') &&
    (value.connection_id === null || typeof value.connection_id === 'string') &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Array.isArray(value.definitions) && Array.isArray(value.measurements) &&
    value.definitions.every(d => d && typeof d.metric_id === 'string' && typeof d.label === 'string') &&
    value.measurements.every(m => m && typeof m.entity_id === 'string' && typeof m.metric_id === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(m.date) && m.definition && typeof m.definition.label === 'string' &&
      (typeof m.value === 'string' || Number.isFinite(m.value))) &&
    (value.target === null || (value.target?.metric_id === 'target_weight' && value.target.unit === 'kg' && Number.isFinite(value.target.value) && value.target.value > 0)) &&
    (value.managed ? value.source === 'sparkyfitness' && typeof value.connection_id === 'string' : value.source === null && value.connection_id === null)
}
