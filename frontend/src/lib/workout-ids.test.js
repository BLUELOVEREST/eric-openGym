import { expect, it } from 'vitest'
import { withWorkoutIds, identifyNewWorkoutRows } from './workout-ids.js'
it('keeps intrinsic IDs through reorder and edits and replaces IDs duplicated by a new row', () => {
  let n = 0
  const mint = () => 'id-' + ++n
  const original = { workouts: [], active: { entries: [{ id: 'squat', sets: [{ w: 20 }, { w: 30 }] }] } }
  const first = withWorkoutIds(original, mint)
  const entry = first.active.entries[0]
  expect(entry.instance_id).toBeTruthy()
  expect(entry.sets[0].set_id).not.toBe(entry.sets[1].set_id)
  expect(original.active.entries[0].instance_id).toBeUndefined()
  const second = withWorkoutIds({ ...first, active: { ...first.active, entries: [{ ...entry, sets: [entry.sets[1], { ...entry.sets[0], w: 25 }, { ...entry.sets[0] }] }] } }, mint)
  expect(second.active.entries[0].instance_id).toBe(entry.instance_id)
  expect(second.active.entries[0].sets[0].set_id).toBe(entry.sets[1].set_id)
  expect(second.active.entries[0].sets[1].set_id).toBe(entry.sets[0].set_id)
  expect(second.active.entries[0].sets[2].set_id).not.toBe(entry.sets[0].set_id)
  expect(withWorkoutIds(second, mint)).toBe(second)
})
it('leaves legacy persisted history to server canonicalization but identifies new sessions', () => {
  const legacy = { id: 'old', entries: [{ id: 'squat', sets: [{ w: 20 }] }] }
  const previous = { workouts: [legacy], active: legacy }
  expect(identifyNewWorkoutRows(previous, { ...previous, restSec: 60 }).workouts[0]).toBe(legacy)
  expect(identifyNewWorkoutRows(previous, { ...previous, restSec: 60 }).active).toBe(legacy)
  const fresh = identifyNewWorkoutRows(previous, { workouts: [legacy], active: { ...legacy, id: 'new' } })
  expect(fresh.active.entries[0].instance_id).toBeTruthy()
  expect(fresh.active.entries[0].sets[0].set_id).toBeTruthy()
})
