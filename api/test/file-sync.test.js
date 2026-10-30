import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncDirectory } from '../storage/file-sync.js'

test('directory sync flushes and closes its descriptor', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-dir-sync-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sync = t.mock.method(fs, 'fsyncSync')
  const close = t.mock.method(fs, 'closeSync')
  syncDirectory(dir)
  assert.equal(sync.mock.callCount(), 1)
  assert.equal(close.mock.callCount(), 1)
})

test('sync failures propagate while still closing the descriptor', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-dir-sync-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const close = t.mock.method(fs, 'closeSync')
  t.mock.method(fs, 'fsyncSync', () => { throw new Error('sync failed') })
  assert.throws(() => syncDirectory(dir), /sync failed/)
  assert.equal(close.mock.callCount(), 1)
})
