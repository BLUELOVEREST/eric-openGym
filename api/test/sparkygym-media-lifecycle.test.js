import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openIntegrationStore } from '../storage/integration-store.js'

function fixture(t) {
  const store = openIntegrationStore(':memory:')
  t.after(() => store.close())
  const id = '22222222-2222-4222-8222-222222222222'
  store.commitProfile('owner', 0, { workouts: [] })
  store.createConnection('owner', { id, peer_origin: 'https://sf.example', peer_user_id: 'sf', scopes: ['personal_media'] })
  store.prepareConnection('owner', id, { version: 1 }, { ciphertext: 'sealed', iv: 'iv', tag: 'tag' })
  store.activateConnection('owner', id, { ciphertext: 'sealed', iv: 'iv', tag: 'tag' })
  while (store.pendingControls().length) for (const row of store.pendingControls()) store.finishControl(row.request_id, 'delivered')
  const media = { hash: 'a'.repeat(64), size: 8, mime: 'image/jpeg', caption: '' }
  store.commitProfile('owner', store.getRevision('owner'), { workouts: [{ id: 'w1', d: '2026-10-29', entries: [], media: [media] }] })
  while (store.pending('owner').length) for (const row of store.pending('owner')) {
    const event = JSON.parse(row.body)
    store.acknowledge('owner', event.event_id, { version: 1, event_id: event.event_id, revision: event.revision, status: 'applied' })
  }
  assert.equal(store.pendingMedia().length, 1)
  return { store, id, media }
}

test('source deletion cancels an unfinished byte transfer and its GC pin atomically', t => {
  const { store } = fixture(t)
  const saved = store.getProfile('owner')
  saved.state.workouts[0].media = []
  store.commitProfile('owner', saved.revision, saved.state)
  assert.deepEqual(store.pendingMedia(), [])
  assert.deepEqual(store.pendingMediaHashes('owner'), [])
  const deletion = JSON.parse(store.pending('owner')[0].body)
  assert.equal(deletion.resource, 'personal_media')
  assert.equal(deletion.operation, 'delete')
})

test('revocation releases byte-transfer GC pins without deleting the authoritative photo', t => {
  const { store, id, media } = fixture(t)
  store.revokeConnection('owner', id)
  assert.deepEqual(store.pendingMediaHashes('owner'), [])
  assert.deepEqual(store.getProfile('owner').state.workouts[0].media, [media])
})
