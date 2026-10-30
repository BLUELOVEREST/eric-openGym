// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('../lib/api.js', () => ({ api: vi.fn(async () => ({ ok: true, rev: 1 })) }))
import { api } from '../lib/api.js'
import { useStore, DEF } from './useStore.js'
import { setBodyOwner, useSparkyGym, readBodyState } from '../lib/sparkygym-client.js'

const source = { managed: true, source: 'sparkyfitness', connection_id: 'paired', revision: 1, definitions: [], measurements: [
  { entity_id: 'sf-weight', metric_id: 'weight', date: '2026-10-29', value: 80, unit: 'kg', measured_at: null, timezone: 'UTC', definition: { label: 'Weight', value_type: 'mass', builtin: true } },
], target: { metric_id: 'target_weight', value: 75, unit: 'kg', effective_date: null } }
beforeEach(() => {
  localStorage.clear(); vi.useFakeTimers(); api.mockReset(); api.mockResolvedValue({ ok: true, rev: 1 })
  useStore.setState({ user: { id: 'alice' }, ready: true, S: structuredClone(DEF) })
  setBodyOwner('alice'); useSparkyGym.setState({ body: source })
})
afterEach(() => { setBodyOwner(null); useStore.setState({ user: null }); vi.useRealTimers() })
it('blocks ordinary edits and AI-style profile changes without blocking training', () => {
  useStore.getState().update(state => { state.bodyweight = [{ d: '2026-10-29', w: 1 }]; state.targetW = 1; state.measurements = [{ d: '2026-10-29', waist: 1 }]; state.restSec = 120 }, false)
  expect(useStore.getState().S.bodyweight).toEqual([])
  expect(useStore.getState().S.targetW).toBeNull()
  expect(readBodyState(useStore.getState().S).bodyweight[0].w).toBe(80)
  expect(useStore.getState().S.restSec).toBe(120)
})
it('omits managed body keys on native profile writes and keeps the training domain', async () => {
  useStore.getState().update(state => { state.routines = [{ id: 'routine', name: 'Training', ex: [] }] }, false)
  await useStore.getState().pushState()
  const sent = JSON.parse(api.mock.calls.find(([, init]) => init?.method === 'PUT')[1].body).state
  expect(sent.routines[0].name).toBe('Training')
  for (const key of ['bodyweight', 'measurements', 'customMeasurements', 'measurementEnabled', 'targetW']) expect(sent).not.toHaveProperty(key)
})
it('keeps external body history across reset and backup import without exporting credentials', async () => {
  await useStore.getState().resetEverything()
  useStore.getState().importBackup({ ...structuredClone(DEF), targetW: 1, bodyweight: [{ d: '2026-10-29', w: 1 }] })
  expect(readBodyState(useStore.getState().S).bodyweight[0].w).toBe(80)
  expect(readBodyState(useStore.getState().S).targetW).toBe(75)
  expect(useSparkyGym.getState().body).toEqual(source)
  const backup = JSON.stringify(useStore.getState().S)
  expect(backup).not.toContain('connection_id')
  expect(backup).not.toContain('sf-weight')
})
it('keeps ordinary local body editing unchanged with an explicit unmanaged snapshot', () => {
  useSparkyGym.setState({ body: { managed: false, source: null, connection_id: null, revision: 0, definitions: [], measurements: [], target: null } })
  useStore.getState().update(state => { state.bodyweight = [{ d: '2026-10-29', w: 70 }]; state.targetW = 65 }, false)
  expect(readBodyState(useStore.getState().S).bodyweight[0].w).toBe(70)
  expect(useStore.getState().S.targetW).toBe(65)
})

it('keeps local data but does not upload while body ownership cannot be established', async () => {
  useSparkyGym.setState({ body: null })
  api.mockRejectedValueOnce(new TypeError('offline'))
  useStore.getState().update(state => { state.bodyweight = [{ d: '2026-10-29', w: 70 }] }, false)
  await useStore.getState().pushState()
  expect(useStore.getState().S.bodyweight[0]?.w).toBe(70)
  expect(api.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
})

it('resolves unpaired ownership before uploading the complete native body history', async () => {
  useSparkyGym.setState({ body: null })
  api.mockImplementation(async path => path === '/api/body/profile'
    ? { managed: false, source: null, connection_id: null, revision: 0, definitions: [], measurements: [], target: null }
    : { ok: true, rev: 1 })
  useStore.getState().update(state => { state.bodyweight = [{ d: '2026-10-29', w: 70 }]; state.targetW = 65 }, false)
  await useStore.getState().pushState()
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/body/profile', '/api/data'])
  const payload = JSON.parse(api.mock.calls[1][1].body).state
  expect(payload.bodyweight[0].w).toBe(70)
  expect(payload.targetW).toBe(65)
})
