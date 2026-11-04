import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMediaStore } from '../media.js'
import { createStore } from '../integrations/store.js'
import { createOutbox } from '../integrations/outbox.js'
import { deriveKey } from '../integrations/crypto.js'
import { createIntegrations } from '../integrations/index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-cleanup-sync-'))
process.env.DATA_DIR = dir
const config = await import('../coach/config.js')
after(() => fs.rmSync(dir, { recursive: true, force: true }))
const ioFailure = () => { const error = new Error('injected fsync failure'); error.code = 'EIO'; throw error }

test('integration connection deletion propagates unlink errors and retries directory fsync', t => {
  const connections = path.join(dir, 'connections')
  const store = createStore({ dir: connections, key: deriveKey('a'.repeat(64)) })
  store.add('u_cleanup', { id: 'c1', provider: 'webhook' })
  const unlink = t.mock.method(fs, 'unlinkSync', ioFailure)
  assert.throws(() => store.removeUser('u_cleanup'), /injected fsync failure/)
  unlink.mock.restore()
  const flush = t.mock.method(fs, 'fsyncSync', ioFailure)
  assert.throws(() => store.removeUser('u_cleanup'), /injected fsync failure/)
  flush.mock.restore()
  const retry = t.mock.method(fs, 'fsyncSync')
  store.removeUser('u_cleanup')
  assert.equal(retry.mock.callCount(), 1)
})

test('integration outbox account cleanup does not swallow persistence errors', t => {
  const file = path.join(dir, 'outbox.json')
  const outbox = createOutbox({ file, deliver: async () => ({ ok: true }) })
  outbox.enqueue({ id: 'e', key: 'webhook:u_cleanup:c:workout.finished:w', uid: 'u_cleanup', conn: 'c', payload: {} })
  const flush = t.mock.method(fs, 'fsyncSync', ioFailure)
  assert.throws(() => outbox.dropUser('u_cleanup'), /injected fsync failure/)
  flush.mock.restore()
  outbox.dropUser('u_cleanup')
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).jobs, [])
})

test('account cleanup removes stored integrations even when providers are disabled', () => {
  const dataDir = path.join(dir, 'disabled')
  const enabled = createIntegrations({ dataDir, secret: 'a'.repeat(64), env: { INTEGRATIONS: 'webhook' } })
  enabled.connect('u_cleanup', 'webhook', { url: 'https://example.com/hook' })
  const file = path.join(dataDir, 'integrations', 'u-u_cleanup.json')
  assert.equal(fs.existsSync(file), true)
  const disabled = createIntegrations({ dataDir, secret: 'a'.repeat(64), env: {} })
  disabled.removeUser('u_cleanup')
  assert.equal(fs.existsSync(file), false)
})

test('media deletion retries fsync even after the user directory is already absent', t => {
  const uploads = path.join(dir, 'uploads')
  fs.mkdirSync(path.join(uploads, 'u_cleanup'), { recursive: true })
  const media = createMediaStore({ dir: uploads })
  const failure = t.mock.method(fs, 'fsyncSync', ioFailure)
  assert.throws(() => media.removeUser('u_cleanup'), /injected fsync failure/)
  assert.equal(fs.existsSync(path.join(uploads, 'u_cleanup')), false)
  failure.mock.restore()
  const retry = t.mock.method(fs, 'fsyncSync')
  media.removeUser('u_cleanup')
  assert.equal(retry.mock.callCount(), 1, 'successful retry must flush the parent directory')
})

test('credential cleanup retries fsync when an earlier unlink already succeeded', t => {
  const credential = config.profileAuthFile('u_cleanup')
  fs.writeFileSync(credential, '{}')
  const failure = t.mock.method(fs, 'fsyncSync', ioFailure)
  assert.throws(() => config.clearProfileAuth('u_cleanup'), /injected fsync failure/)
  assert.equal(fs.existsSync(credential), false)
  failure.mock.restore()
  const retry = t.mock.method(fs, 'fsyncSync')
  assert.equal(config.clearProfileAuth('u_cleanup'), false)
  assert.equal(retry.mock.callCount(), 1, 'already-unlinked credentials still need the durability barrier')
})
