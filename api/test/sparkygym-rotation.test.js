import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openIntegrationStore } from '../storage/integration-store.js'
const oldId = '22222222-2222-4222-8222-222222222222', newId = '33333333-3333-4333-8333-333333333333'
const sealed = { ciphertext: 'c', iv: 'i', tag: 't' }
const binding = (id, scopes, includeHistory) => ({
  version: 1, connection_id: id, sf_owner_ref: 'sf-owner', og_owner_ref: 'o',
  sf_origin: 'https://sf.example', og_origin: 'https://og.example',
  sf_nonce: Buffer.alloc(32, 1).toString('base64url'), og_nonce: Buffer.alloc(32, 2).toString('base64url'), scopes, include_history: includeHistory,
})
test('replacement approval atomically retires the same peer binding and retains work until snapshot acknowledgement', t => {
  const s = openIntegrationStore(':memory:'); t.after(() => s.close())
  s.commitProfile('o', 0, { workouts: [] })
  for (const id of [oldId, newId]) {
    s.createConnection('o', { id, peer_origin: 'https://sf.example', peer_user_id: 'sf-owner', scopes: ['body_measurement', 'workout'] })
    s.prepareConnection('o', id, binding(id, ['body_measurement', 'workout'], true), sealed)
  }
  s.activateConnection('o', oldId, sealed)
  while (s.pendingControls().length) for (const job of s.pendingControls()) s.finishControl(job.request_id, 'delivered')
  s.commitProfile('o', s.getRevision('o'), { workouts: [] }, [{ connection_id: oldId, resource: 'workout', entity_id: 'pending-old', operation: 'delete', payload: null }])
  assert.equal(s.pending('o').length, 1)
  s.activateConnection('o', newId, sealed)
  assert.equal(s.getConnection('o', oldId).status, 'revoked')
  assert.ok(s.getConnection('o', oldId).sealed_keys)
  assert.equal(s.getBodyProfile('o').connection_id, newId)
  const replacement = s.getConnection('o', newId)
  assert.equal(replacement.replaces_connection_id, oldId)
  assert.equal(replacement.replacement_snapshot_id, null)
  s.confirmReplacementSnapshot('o', newId, 'wrong')
  assert.ok(s.getConnection('o', oldId).sealed_keys)
  while (s.pendingControls().length) for (const job of s.pendingControls()) {
    if (job.path.endsWith('/snapshot') && JSON.parse(job.body).action === 'begin') {
      s.confirmReplacementSnapshot('o', newId, JSON.parse(job.body).snapshot_id)
      assert.ok(s.getConnection('o', oldId).sealed_keys)
      assert.deepEqual(JSON.parse(job.body).prune_resources, [])
    }
    if (job.path.endsWith('/snapshot') && JSON.parse(job.body).action === 'request') assert.equal(JSON.parse(job.body).include_history, false)
    s.finishControl(job.request_id, 'delivered')
  }
  const full = s.queueNativeSnapshot('o', newId, true)
  s.confirmReplacementSnapshot('o', newId, full.snapshot_id)
  assert.equal(s.getConnection('o', oldId).sealed_keys, null)
})
for (const [scopes, revoked] of [[['workout'], false], [['body_measurement', 'workout'], false], [['body_measurement', 'workout'], true]]) {
  test(`replacement without history approval rolls back all state (${scopes}, revoked=${revoked})`, t => {
    const s = openIntegrationStore(':memory:'); t.after(() => s.close())
    s.commitProfile('o', 0, { workouts: [] })
    for (const id of [oldId, newId]) {
      s.createConnection('o', { id, peer_origin: 'https://sf.example', peer_user_id: 'sf-owner', scopes })
      s.prepareConnection('o', id, binding(id, scopes, id === oldId), sealed)
    }
    s.activateConnection('o', oldId, sealed)
    while (s.pendingControls().length) for (const job of s.pendingControls()) s.finishControl(job.request_id, 'delivered')
    s.commitProfile('o', s.getRevision('o'), { workouts: [] }, [{ connection_id: oldId, resource: 'workout', entity_id: 'pending-old', operation: 'delete', payload: null }])
    if (revoked) s.revokeConnection('o', oldId)
    const before = {
      connections: s.listConnections('o'), body: s.getBodyProfile('o'), archive: s.getBodyArchive('o'),
      profile: s.getProfile('o'), controls: s.pendingControls(), pending: s.pending('o'), notifications: s.notifications('o', 0),
    }
    assert.throws(() => s.activateConnection('o', newId, sealed), /rotation_requires_history_approval/)
    assert.deepEqual({
      connections: s.listConnections('o'), body: s.getBodyProfile('o'), archive: s.getBodyArchive('o'),
      profile: s.getProfile('o'), controls: s.pendingControls(), pending: s.pending('o'), notifications: s.notifications('o', 0),
    }, before)
  })
}
test('fresh approval cannot adopt a different source owner into existing history', t => {
  const s = openIntegrationStore(':memory:'); t.after(() => s.close()); s.commitProfile('o', 0, {})
  for (const [id, peer] of [[oldId, 'first'], [newId, 'different']]) { s.createConnection('o', { id, peer_origin: 'https://sf.example', peer_user_id: peer, scopes: ['body_measurement'] }); s.prepareConnection('o', id, { version: 1 }, sealed) }
  s.activateConnection('o', oldId, sealed)
  assert.throws(() => s.activateConnection('o', newId, sealed), /body_source_exists/)
  assert.equal(s.getConnection('o', oldId).status, 'active')
  assert.equal(s.getConnection('o', newId).status, 'pending')
})
