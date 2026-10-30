import { randomId as mintId } from './ids.js'
const identified = (values, key, mint) => {
  const seen = new Set()
  let changed = false
  const out = values.map(value => {
    let id = value[key]
    if (typeof id !== 'string' || !id || seen.has(id)) { id = mint(); changed = true }
    seen.add(id)
    return id === value[key] ? value : { ...value, [key]: id }
  })
  return changed ? out : values
}
function workoutIds(workout, mint) {
  if (!Array.isArray(workout?.entries)) return workout
  let entries = identified(workout.entries, 'instance_id', mint)
  const next = entries.map(entry => {
    if (!Array.isArray(entry.sets)) return entry
    const sets = identified(entry.sets, 'set_id', mint)
    return sets === entry.sets ? entry : { ...entry, sets }
  })
  if (next.some((entry, index) => entry !== entries[index])) entries = next
  return entries === workout.entries ? workout : { ...workout, entries }
}
export function withWorkoutIds(state, mint = mintId) {
  const workouts = Array.isArray(state.workouts) ? state.workouts.map(workout => workoutIds(workout, mint)) : state.workouts
  const active = state.active ? workoutIds(state.active, mint) : state.active
  if (active === state.active && (!Array.isArray(workouts) || workouts.every((w, i) => w === state.workouts[i]))) return state
  return { ...state, workouts, active }
}

// Legacy history is canonicalized by the API. Do not migrate it as a side effect of an
// unrelated preference edit. New sessions and already identified rows retain client IDs.
export function identifyNewWorkoutRows(previous, state) {
  const old = new Set((previous?.workouts || []).map(workout => workout.id))
  const mapped = (state.workouts || []).map(workout => old.has(workout.id) ? workout : workoutIds(workout, mintId))
  const workouts = mapped.every((workout, index) => workout === state.workouts[index]) ? state.workouts : mapped
  let active = state.active
  if (active) {
    const editingLegacy = active.editingWorkoutId && !(previous?.workouts || []).find(workout => workout.id === active.editingWorkoutId)?.entries?.some(entry => entry.instance_id)
    const sameLegacy = previous?.active && previous.active.id === active.id && !previous.active.entries?.some(entry => entry.instance_id)
    if (!editingLegacy && !sameLegacy) active = workoutIds(active, mintId)
  }
  if (active === state.active && workouts === state.workouts) return state
  return { ...state, workouts, active }
}
