import { createHash } from 'node:crypto'
import { isUuid } from './sparkygym-protocol.js'
export function membershipHash(entities) {
  const hash = createHash('sha256')
  const keys = entities.map(entity => Buffer.from(entity.resource + '\0' + entity.entity_id + '\n')).sort(Buffer.compare)
  for (const key of keys) hash.update(key)
  return hash.digest('hex')
}
export function validateSnapshot(value, scopes) {
  const keys = { request: ['version', 'action', 'connection_id', 'include_history'], begin: ['version', 'action', 'connection_id', 'snapshot_id', 'start_cursor', 'watermark', 'expected_count', 'membership_sha256', 'prune_resources'], complete: ['version', 'action', 'connection_id', 'snapshot_id'] }[value?.action]
  let valid = keys && value.version === 1 && isUuid(value.connection_id) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
  if (value?.action === 'request') valid &&= typeof value.include_history === 'boolean'
  else valid &&= isUuid(value?.snapshot_id)
  if (value?.action === 'begin') valid &&= Number.isSafeInteger(value.start_cursor) && value.start_cursor >= 0 && Number.isSafeInteger(value.watermark) && value.watermark >= 0 && value.watermark >= value.start_cursor - 1 && Number.isSafeInteger(value.expected_count) && value.expected_count >= 0 && /^[a-f0-9]{64}$/.test(value.membership_sha256) && Array.isArray(value.prune_resources) && new Set(value.prune_resources).size === value.prune_resources.length && value.prune_resources.every(resource => scopes.includes(resource))
  if (!valid) throw new TypeError('invalid_snapshot')
  return value
}
