import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMediaStore } from '../media.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-cleanup-sync-'))
process.env.DATA_DIR = dir
const config = await import('../coach/config.js')
after(() => fs.rmSync(dir, { recursive: true, force: true }))
const ioFailure = () => { const error = new Error('injected fsync failure'); error.code = 'EIO'; throw error }

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
