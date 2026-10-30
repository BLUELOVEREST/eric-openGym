import { test, expect } from 'vitest'
import { logWorkout, _resetWriteWindow } from '../src/write-tools.js'
import { _seedStateForTests } from '../src/state.js'
import { MANAGED_BODY_FIELDS } from '../../api/integrations/sparkygym-body-model.js'

for (const managed of [true, false]) {
  test(`workout writes preserve body ownership (managed=${managed}) without sockets`, async () => {
    _resetWriteWindow()
    _seedStateForTests({})
    const doc = { unit: 'kg', _rev: 4, _wid: 'original', workouts: [], routines: [], customEx: [], exWeights: {},
      bodyweight: [{ d: '2026-10-28', w: 80 }], measurements: [], customMeasurements: [], measurementEnabled: null, targetW: 75 }
    const writes = []
    let ownershipReads = 0
    const fetchImpl = async (url, options) => {
      expect(options.headers['X-SparkyGym-Client-Version']).toBe('1')
      let body, status = 200
      if (url.endsWith('/api/me')) body = { user: { id: 'test-uid' } }
      else if (url.endsWith('/api/body/profile')) { ownershipReads++; body = { managed } }
      else if (options.method === 'GET') body = { state: doc, rev: 4 }
      else {
        writes.push(JSON.parse(options.body))
        if (writes.length === 1) { status = 409; body = { state: { ...doc, _wid: 'concurrent' }, rev: 5 } }
        else body = { rev: 6 }
      }
      return { status, ok: status === 200, json: async () => body }
    }
    const result = await logWorkout.handler({ date: '2026-10-01', exercises: [{ exercise: 'dumbbell curl', sets: [{ reps: 10, weight: 12 }] }] },
      { env: { OPENGYM_URL: 'https://gym.example.com', OPENGYM_TOKEN: 'test.token' }, fetchImpl })
    expect(result.logged).toBe(true)
    expect(ownershipReads).toBe(2)
    expect(writes.map(write => write.baseRev)).toEqual([4, 5])
    expect(writes.map(write => write.baseWid)).toEqual(['original', 'concurrent'])
    for (const write of writes) {
      expect(write.state.workouts).toHaveLength(1)
      expect(write.state._rev).toBe(4)
      for (const field of MANAGED_BODY_FIELDS) {
        if (managed) expect(Object.hasOwn(write.state, field)).toBe(false)
        else expect(write.state[field]).toEqual(doc[field])
      }
    }
  })
}
