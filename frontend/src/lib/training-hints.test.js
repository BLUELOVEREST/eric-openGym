// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('./api.js', () => ({ api: (...args) => mocks.api(...args), apiEvents: vi.fn(), remoteAuth: () => null }))
vi.mock('./mobile.js', () => ({ MOBILE: false }))
import { setBodyOwner, refreshTrainingHints, useSparkyGym, refreshBody, currentBody } from './sparkygym-client.js'
import { hintsForDate } from './training-hints.js'
const metadata = () => ({ revision: 1, date: null, hints: [{ entity_id: '42', name: 'Next week', timezone: 'UTC', week_start: 1, effective_from: '2026-11-02', effective_until: null, days: [{ weekday: 1, slots: [{ time_slot: 'morning', activity: 'Chest', is_main: true }] }] }] })
beforeEach(() => { localStorage.clear(); setBodyOwner(null); mocks.api.mockReset() })
it('keeps applicable sparse templates on omitted rest weekdays and never invents missing metadata', () => {
  const value = metadata()
  value.hints[0].effective_until = '2026-11-08'
  expect(hintsForDate(value, '2026-11-03')).toHaveLength(1)
  expect(hintsForDate(value, '2026-11-01')).toEqual([])
  expect(hintsForDate(value, '2026-11-09')).toEqual([])
  expect(hintsForDate(null, '2026-11-03')).toEqual([])
})
it('coalesces metadata reads and keeps future guidance available offline without daily API requests', async () => {
  setBodyOwner('alice', 'https://one.example')
  mocks.api.mockResolvedValue(metadata())
  await Promise.all([refreshTrainingHints(), refreshTrainingHints()])
  expect(mocks.api).toHaveBeenCalledTimes(1)
  expect(mocks.api).toHaveBeenCalledWith('/api/training-hints')
  expect(hintsForDate(useSparkyGym.getState().trainingHints, '2026-11-02')).toHaveLength(1)
  setBodyOwner(null); setBodyOwner('alice', 'https://one.example')
  mocks.api.mockRejectedValue(new Error('offline'))
  await expect(refreshTrainingHints()).rejects.toThrow('offline')
  expect(hintsForDate(useSparkyGym.getState().trainingHints, '2026-11-09')).toHaveLength(1)
})
it('owner/server changes isolate hints and ignore stale replies without disturbing body ownership', async () => {
  setBodyOwner('alice', 'https://one.example')
  const body = { managed: true, source: 'sparkyfitness', connection_id: 'c', revision: 2, definitions: [], measurements: [], target: null }
  mocks.api.mockResolvedValueOnce(body)
  await refreshBody()
  let resolve
  mocks.api.mockReturnValueOnce(new Promise(r => { resolve = r }))
  const pending = refreshTrainingHints()
  setBodyOwner('bob', 'https://two.example')
  resolve(metadata()); await pending
  expect(useSparkyGym.getState().trainingHints).toBeNull()
  expect(currentBody()).toBeNull()
  setBodyOwner('alice', 'https://one.example')
  expect(currentBody()).toEqual(body)
  mocks.api.mockResolvedValueOnce({ ...metadata(), date: '2026-11-02' })
  await expect(refreshTrainingHints()).rejects.toThrow()
  expect(currentBody()).toEqual(body)
  expect(useSparkyGym.getState().trainingHints).toBeNull()
})
