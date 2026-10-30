// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { api, apiEvents, setRemoteAuth } from './api.js'
afterEach(() => { setRemoteAuth('', null); vi.unstubAllGlobals() })
it('sends the native client version on JSON writes', async () => {
  const fetch = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  await api('/api/data', { method: 'PUT', body: '{}' })
  expect(fetch.mock.calls[0][1].headers['X-SparkyGym-Client-Version']).toBe('1')
})
it('authenticates a remote SSE fetch with bearer headers and a durable cursor', async () => {
  setRemoteAuth('https://gym.example', 'private-device-token')
  const events = []
  const fetchImpl = vi.fn(async () => new Response('id: 17\nevent: body_changed\ndata: {"revision":4}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
  await apiEvents('/api/integrations/sparkygym/notifications', { cursor: '16', fetchImpl, onEvent: e => events.push(e) })
  expect(fetchImpl.mock.calls[0][0]).toBe('https://gym.example/api/integrations/sparkygym/notifications')
  expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer private-device-token', 'Last-Event-ID': '16', 'X-SparkyGym-Client-Version': '1' })
  expect(fetchImpl.mock.calls[0][1].credentials).toBe('omit')
  expect(events[0]).toEqual({ id: '17', event: 'body_changed', data: { revision: 4 } })
})
it('rejects an HTML proxy response instead of accepting a silent event stream', async () => {
  const fetchImpl = async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } })
  await expect(apiEvents('/api/integrations/sparkygym/notifications', { fetchImpl, onEvent() {} })).rejects.toMatchObject({ code: 'bad-response' })
})
