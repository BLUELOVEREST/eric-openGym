import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { encodeMediaFrame, parseMediaFrame } from '../integrations/sparkygym-media.js'
const id = '22222222-2222-4222-8222-222222222222'
test('personal GIF frames validate magic and reject malformed Unicode media IDs', () => {
  const bytes = Buffer.from('GIF89a12345678'), metadata = { connection_id: id, request_id: id, media_id: 'gif-1', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mime: 'image/gif' }
  assert.deepEqual(parseMediaFrame(encodeMediaFrame(metadata, bytes)).bytes, bytes)
  assert.throws(() => encodeMediaFrame({ ...metadata, media_id: '\ud800' }, bytes), /invalid_media_metadata/)
})
test('personal binary frame binds bounded metadata, exact bytes, MIME magic and hash', () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
  const metadata = { connection_id: id, request_id: id, media_id: 'photo-1', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mime: 'image/jpeg' }
  const frame = encodeMediaFrame(metadata, bytes)
  assert.equal(frame.readUInt32BE(), Buffer.byteLength(JSON.stringify(metadata)))
  assert.deepEqual(parseMediaFrame(frame).metadata, metadata)
  const broken = Buffer.from(frame); broken[broken.length - 1] ^= 1
  assert.throws(() => parseMediaFrame(broken), /media_hash_mismatch/)
  assert.throws(() => encodeMediaFrame({ ...metadata, mime: 'image/png' }, bytes), /media_mime_mismatch/)
  assert.throws(() => encodeMediaFrame({ ...metadata, url: 'https://example.com' }, bytes), /invalid_media_metadata/)
  assert.throws(() => parseMediaFrame(frame, { maxBytes: 2 }), /media_too_large/)
})
