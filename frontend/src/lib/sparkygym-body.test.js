import { describe, expect, it } from 'vitest'
import { bodyView, bodyWriteState, validateBodyProfile } from './sparkygym-body.js'
import { measurementValue, measurementSeries } from './measurements.js'

const model = { managed: true, source: 'sparkyfitness', connection_id: 'c1', revision: 2,
  definitions: [{ metric_id: 'biceps_left', label: 'Left biceps', value_type: 'length', unit: 'cm', enabled: true, builtin: true }],
  measurements: [
    { entity_id: 'w1', metric_id: 'weight', date: '2026-10-28', value: 80, unit: 'kg', measured_at: null, timezone: 'UTC', definition: { label: 'Weight', value_type: 'mass', builtin: true } },
    { entity_id: 'b1', metric_id: 'biceps_left', date: '2026-10-28', value: 35, unit: 'cm', measured_at: null, timezone: 'UTC', definition: { label: 'Left biceps', value_type: 'length', builtin: true } },
  ], target: { metric_id: 'target_weight', value: 75, unit: 'kg', effective_date: null } }

describe('SparkyFitness body read model', () => {
  it('derives a unit-aware display without writing external data into the profile', () => {
    const local = { unit: 'lb', targetW: 1, bodyweight: [], measurements: [], workouts: [{ id: 'w' }] }
    const out = bodyView(local, model)
    expect(out.bodyweight[0].w).toBeCloseTo(176.3698, 3)
    expect(out.targetW).toBeCloseTo(165.3467, 3)
    expect(out.measurements[0].upperArmLeft).toBeUndefined()
    expect(out.measurements[0].other[0]).toMatchObject({ id: 'biceps_left', value: 35 })
    expect(out.workouts).toBe(local.workouts)
    expect(local.bodyweight).toEqual([])
  })
  it('omits every managed field from writes and preserves training snapshots', () => {
    const local = { bodyweight: [1], targetW: 2, measurements: [3], customMeasurements: [4], measurementEnabled: [5], workouts: [{ bodyWeight: 80 }], unit: 'kg' }
    expect(bodyWriteState(local, model)).toEqual({ workouts: local.workouts, unit: 'kg' })
    expect(bodyWriteState(local, { managed: false })).toBe(local)
    expect(bodyWriteState(local, null)).toEqual({ workouts: local.workouts, unit: 'kg' })
  })
  it('uses local values only for explicitly unmanaged snapshots', () => {
    const local = { bodyweight: [{ w: 10 }], targetW: 9 }
    expect(bodyView(local, { managed: false })).toBe(local)
    expect(bodyView(local, null).bodyweight).toEqual([])
    expect(bodyView(local, null).targetW).toBeNull()
  })
  it('rejects malformed snapshots rather than unlocking local mode', () => {
    expect(validateBodyProfile({ managed: false })).toBe(false)
    expect(validateBodyProfile(model)).toBe(true)
    expect(validateBodyProfile({ ...model, measurements: null })).toBe(false)
  })
  it('retains explicit text and signed unitless source readings without making up units', () => {
    const source = { ...model, measurements: [
      { ...model.measurements[1], entity_id: 'text', metric_id: 'custom:text', value: 'not measured', unit: 'text', definition: { label: 'Comment', value_type: 'text', builtin: false } },
      { ...model.measurements[1], entity_id: 'score', metric_id: 'custom:score', value: -2, unit: 'none', definition: { label: 'Score', value_type: 'number', builtin: false } },
    ] }
    const view = bodyView({ unit: 'lb' }, source)
    expect(measurementValue(view.measurements[0], 'other:custom:text')).toBe('not measured')
    expect(measurementValue(view.measurements[0], 'other:custom:score')).toBe(-2)
    expect(measurementSeries(view, 'other:custom:text')).toEqual([])
    expect(measurementSeries(view, 'other:custom:score')[0].y).toBe(-2)
  })
})
