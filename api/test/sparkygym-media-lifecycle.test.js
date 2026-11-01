import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openIntegrationStore } from '../storage/integration-store.js'

function fixture(t) {
  const store = openIntegrationStore(':memory:')
  t.after(() => store.close())
  const id = '22222222-2222-4222-8222-222222222222'
  store.commitProfile('owner', 0, { workouts: [] })
  store.createConnection('owner', { id, peer_origin: 'https://sf.example', peer_user_id: 'sf', scopes: ['personal_media'] })
  store.prepareConnection('owner', id, { version: 1, include_history: true }, { ciphertext: 'sealed', iv: 'iv', tag: 'tag' })
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
test('full snapshot retries cannot multiply pending media and preserve stable media identity', t => {
  const { store, id, media } = fixture(t)
  const before = store.pendingMedia()[0]
  store.finishMedia(before.request_id, 'pending', Date.now() + 1000, 'media_delivery_pending')
  const retry = store.pendingMedia(Number.MAX_SAFE_INTEGER)[0]
  assert.equal(retry.request_id, before.request_id)
  assert.deepEqual(retry.metadata, before.metadata)
  store.finishMedia(before.request_id, 'ready')
  store.queueNativeSnapshot('owner', id, true)
  for (const method of ['queueNativeSnapshot', 'queueTwoWaySnapshot']) assert.throws(() => store[method]('owner', id, true), /snapshot_in_progress/)
  const packets = []
  while (store.pendingControls().length || store.pending('owner').length) {
    for (const job of store.pendingControls()) store.finishControl(job.request_id, 'delivered')
    for (const job of store.pending('owner')) {
      const event = JSON.parse(job.body); packets.push(event)
      store.acknowledge('owner', event.event_id, { version: 1, event_id: event.event_id, revision: event.revision, status: 'applied' })
    }
  }
  assert.equal(packets.filter(event => event.resource === 'personal_media').length, 1)
  const transfer = store.pendingMedia()[0]
  assert.equal(store.pendingMedia().length, 1)
  assert.equal(transfer.metadata.media_id, before.metadata.media_id)
  assert.equal(transfer.metadata.sha256, media.hash)
  assert.deepEqual(store.pendingMediaHashes('owner'), [media.hash])
})
