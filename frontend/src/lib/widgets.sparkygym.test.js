// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { startWidgetSync, _setWidgetPluginForTest, _resetWidgets } from './widgets.js'
import { setBodyOwner, useSparkyGym } from './sparkygym-client.js'
import { todayISO } from './format.js'
import { bodyweightFor } from './bw-load.js'

afterEach(() => { setBodyOwner(null); _resetWidgets(); vi.useRealTimers() })

it('uses SF weight for bodyweight volume and refreshes widgets on source-only changes', async () => {
  vi.useFakeTimers()
  const d = todayISO()
  const workout = { id: 'pull', d, entries: [{ id: '0652', target: { mode: 'reps' }, sets: [{ w: 0, r: 1, done: true }] }] }
  const S = { unit: 'kg', volumeBodyweight: true, bodyweight: [], workouts: [workout], routines: [], week: {}, dayPlan: {} }
  const useStore = create(() => ({ S }))
  setBodyOwner('widget-owner')
  const body = { managed: true, definitions: [], target: null, measurements: [
    { entity_id: 'sf-weight', metric_id: 'weight', date: d, value: 80, unit: 'kg', measured_at: null },
  ] }
  useSparkyGym.setState({ body })
  expect(bodyweightFor(workout, S)).toBe(0)
  const write = vi.fn(async () => {})
  _setWidgetPluginForTest({ write })
  const stop = await startWidgetSync({ useStore })
  try {
    await vi.advanceTimersByTimeAsync(1000)
    expect(JSON.parse(write.mock.calls.at(-1)[0].json).volume.now).toBe(80)
    useSparkyGym.setState({ body: { ...body, measurements: [{ ...body.measurements[0], value: 82 }] } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(JSON.parse(write.mock.calls.at(-1)[0].json).volume.now).toBe(82)
    expect(useStore.getState().S).toBe(S)
    expect(S.bodyweight).toEqual([])
  } finally { stop() }
  const count = write.mock.calls.length
  useSparkyGym.setState({ body: null })
  await vi.advanceTimersByTimeAsync(1000)
  expect(write).toHaveBeenCalledTimes(count)
})
