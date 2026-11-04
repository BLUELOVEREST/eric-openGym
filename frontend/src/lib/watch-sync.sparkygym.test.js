// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { applyEvents, bindWatchAppActions, watchExtras, _resetWatchSync } from './watch-sync.js'
import { setBodyOwner, useSparkyGym } from './sparkygym-client.js'

afterEach(() => { setBodyOwner(null); _resetWatchSync() })

it.each([null, { managed: true }])('acknowledges but does not apply watch weigh-ins with read-only body ownership %j', body => {
  setBodyOwner('watch-owner')
  useSparkyGym.setState({ body })
  const weighIn = vi.fn()
  bindWatchAppActions({ weighIn })
  const S = { weighIn: true, bodyweight: [{ d: '2026-10-28', w: 80 }] }
  expect(watchExtras(S)).toMatchObject({ weighIn: false, lastBw: 80 })
  expect(applyEvents([{ id: 'managed-weigh-in', type: 'weighIn', w: 1 }], () => ({ S }))).toEqual(['managed-weigh-in'])
  expect(weighIn).not.toHaveBeenCalled()
})

it('keeps ordinary local watch weigh-ins enabled', () => {
  setBodyOwner(null)
  const weighIn = vi.fn()
  bindWatchAppActions({ weighIn })
  expect(watchExtras({ weighIn: true }).weighIn).toBe(true)
  applyEvents([{ id: 'local-weigh-in', type: 'weighIn', w: 80 }], () => ({ S: {} }))
  expect(weighIn).toHaveBeenCalledWith(expect.objectContaining({ w: 80 }))
})
