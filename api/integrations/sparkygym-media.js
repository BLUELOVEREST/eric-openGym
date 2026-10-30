import { createHash } from 'node:crypto'
import { isUuid } from './sparkygym-protocol.js'
import { sniffMedia } from '../media.js'

export const PERSONAL_MEDIA_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime', 'video/webm'])
export function isWellFormedText(value) { return typeof value === 'string' && value.isWellFormed() }
const fail = code => { throw new TypeError(code) }
export function validateMediaMetadata(metadata, maxBytes = 104_857_600) {
  const keys = ['connection_id', 'request_id', 'media_id', 'sha256', 'bytes', 'mime']
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length !== keys.length || !keys.every(key => Object.hasOwn(metadata, key)) || !isUuid(metadata.connection_id) || !isUuid(metadata.request_id) || typeof metadata.media_id !== 'string' || !/^[^\x00-\x1f\x7f]{1,200}$/.test(metadata.media_id) || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || !PERSONAL_MEDIA_MIMES.includes(metadata.mime)) fail('invalid_media_metadata')
  if (!isWellFormedText(metadata.media_id)) fail('invalid_media_metadata')
  if (metadata.bytes > maxBytes) fail('media_too_large')
}
function validateBytes(metadata, bytes) {
  if (metadata.bytes !== bytes.length) fail('media_size_mismatch')
  if (sniffMedia(bytes.subarray(0, 64))?.mime !== metadata.mime) fail('media_mime_mismatch')
  if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) fail('media_hash_mismatch')
}
export function encodeMediaFrame(metadata, bytes, options = {}) {
  validateMediaMetadata(metadata, options.maxBytes)
  if (!Buffer.isBuffer(bytes)) fail('invalid_media_bytes')
  validateBytes(metadata, bytes)
  const json = Buffer.from(JSON.stringify(metadata)), length = Buffer.alloc(4)
  if (json.length > 16_384) fail('invalid_media_metadata')
  length.writeUInt32BE(json.length)
  return Buffer.concat([length, json, bytes])
}
export function parseMediaFrame(frame, { maxBytes = 104_857_600 } = {}) {
  if (!Buffer.isBuffer(frame) || frame.length < 5) fail('invalid_media_frame')
  if (frame.length > maxBytes + 16_388) fail('media_too_large')
  const length = frame.readUInt32BE()
  if (length < 2 || length > 16_384 || frame.length <= length + 4) fail('invalid_media_frame')
  let metadata
  try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4, length + 4))) } catch { fail('invalid_media_metadata') }
  validateMediaMetadata(metadata, maxBytes)
  const bytes = frame.subarray(length + 4)
  validateBytes(metadata, bytes)
  return { metadata, bytes }
}
