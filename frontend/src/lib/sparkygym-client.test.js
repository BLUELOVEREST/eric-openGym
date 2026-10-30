// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ api: vi.fn(), events: vi.fn() }))
vi.mock('./api.js', () => ({ api: (...args) => mocks.api(...args), apiEvents: (...args) => mocks.events(...args), remoteAuth: () => null }))
vi.mock('./mobile.js', () => ({ MOBILE: false }))
import { setBodyOwner, refreshBody, currentBody, bodyReadOnly, useSparkyGym, startIntegration } from './sparkygym-client.js'
const body = { managed: true, source: 'sparkyfitness', connection_id: 'c', revision: 2, definitions: [], measurements: [], target: null }
beforeEach(() => { localStorage.clear(); setBodyOwner(null); mocks.api.mockReset(); mocks.events.mockReset() })

it('coalesces a replay burst and checkpoints only after reading its snapshots', async () => {
  setBodyOwner('alice')
  mocks.api.mockImplementation(path => Promise.resolve(path === '/api/body/profile' ? body : path === '/api/training-hints' ? { revision: 0, date: null, hints: [] } : { connections: [] }))
  mocks.events.mockImplementation(async (_path, { onEvent, signal }) => {
    for (let id = 1; id <= 20; id++) onEvent({ event: 'change', id: String(id), data: {} })
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  })
  const stop = startIntegration('alice')
  try {
    await vi.waitFor(() => expect(localStorage.getItem('opengym_external_body_v1:' + useSparkyGym.getState().scope + ':cursor')).toBe('20'))
    expect(mocks.api.mock.calls.filter(([path]) => path === '/api/body/profile').length).toBeLessThanOrEqual(3)
  } finally { stop() }
})
it('retains managed ownership after refresh failure and scopes caches to their owner', async () => {
  setBodyOwner('alice')
  mocks.api.mockResolvedValueOnce(body)
  await refreshBody()
  mocks.api.mockRejectedValueOnce(new Error('offline'))
  await expect(refreshBody()).rejects.toThrow('offline')
  expect(currentBody()).toEqual(body)
  expect(bodyReadOnly()).toBe(true)
  setBodyOwner('bob')
  expect(currentBody()).toBeNull()
  expect(bodyReadOnly()).toBe(true)
  setBodyOwner('alice')
  expect(currentBody()).toEqual(body)
  setBodyOwner(null)
  expect(bodyReadOnly()).toBe(false)
})
it('does not accept a proxy-shaped success as unmanaged local mode', async () => {
  setBodyOwner('alice')
  mocks.api.mockResolvedValueOnce({ ok: true })
  await expect(refreshBody()).rejects.toThrow()
  expect(bodyReadOnly()).toBe(true)
  expect(useSparkyGym.getState().error).toBeTruthy()
})
it('ignores late replies after changing owners', async () => {
  let resolve
  mocks.api.mockReturnValueOnce(new Promise(r => { resolve = r }))
  setBodyOwner('alice')
  const request = refreshBody()
  setBodyOwner('bob')
  resolve(body)
  await request
  expect(currentBody()).toBeNull()
})
