import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openIntegrationStore } from '../storage/integration-store.js'

test('explicit resume makes retryable queued work immediately eligible', t => {
  const store = openIntegrationStore(':memory:')
  t.after(() => store.close())
  const id = '22222222-2222-4222-8222-222222222222'
  store.commitProfile('owner', 0, {})
  store.createConnection('owner', { id, peer_origin: 'https://sf.example', peer_user_id: 'peer', scopes: ['workout'] })
  store.activateConnection('owner', id, { ciphertext: 'fixture', iv: 'fixture', tag: 'fixture' })
  store.commitProfile('owner', 1, {}, [{ connection_id: id, resource: 'workout', entity_id: 'workout', operation: 'upsert', payload: { name: 'Training' } }])
  const event = JSON.parse(store.pending('owner')[0].body)
  store.retry('owner', event.event_id, Date.now() + 3600000, 'delivery_failed')
  store.pauseConnection('owner', id, true)
  assert.equal(store.pending('owner').length, 0)
  store.pauseConnection('owner', id, false)
  assert.equal(store.pending('owner').length, 1)
  assert.equal(JSON.parse(store.pending('owner')[0].body).event_id, event.event_id)
})
