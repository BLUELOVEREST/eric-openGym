import { createHash, createHmac, hkdfSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'
import { isUuid } from './sparkygym-protocol.js'

const controls = new Set(['POST /api/integrations/v1/pair/claim', 'POST /api/integrations/v1/pair/accept', 'GET /api/integrations/v1/capabilities', 'POST /api/integrations/v1/snapshot', 'POST /api/integrations/v1/media', 'POST /api/integrations/v1/revoke'])
const invalid = () => { throw new TypeError('invalid_signing_input') }
const digest = body => createHash('sha256').update(body).digest('hex')
function canonical(prefix, fields, body, keyId, timestamp, secret) {
  if (!Buffer.isBuffer(body) || typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || typeof timestamp !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) || !Buffer.isBuffer(secret) || secret.length !== 32) invalid()
  return 'v1=' + createHmac('sha256', secret).update([prefix, ...fields, timestamp, keyId, digest(body)].join('\n')).digest('hex')
}
function verify(signature, timestamp, now, sign) {
  if (typeof signature !== 'string' || !/^v1=[a-f0-9]{64}$/.test(signature) || !Number.isSafeInteger(now) || now < 0 || Math.abs(now - Number(timestamp)) > 300) return false
  try { return timingSafeEqual(Buffer.from(signature.slice(3), 'hex'), Buffer.from(sign().slice(3), 'hex')) } catch { return false }
}
export function signControl(method, path, body, keyId, timestamp, secret, requestId) {
  if (!controls.has(method + ' ' + path) || !isUuid(requestId)) invalid()
  return canonical('sparkygym-control-v1', [method, path, requestId], body, keyId, timestamp, secret)
}
export function verifyControl(method, path, body, keyId, timestamp, signature, secret, requestId, now = Math.floor(Date.now() / 1000)) {
  return verify(signature, timestamp, now, () => signControl(method, path, body, keyId, timestamp, secret, requestId))
}
export function signResponse(requestId, status, body, keyId, timestamp, secret) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId) || !Number.isInteger(status) || status < 100 || status > 599) invalid()
  return canonical('sparkygym-response-v1', [requestId, String(status)], body, keyId, timestamp, secret)
}
export function verifyResponse(requestId, status, body, keyId, timestamp, signature, secret, now = Math.floor(Date.now() / 1000)) {
  return verify(signature, timestamp, now, () => signResponse(requestId, status, body, keyId, timestamp, secret))
}
function nonce(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) invalid()
  return Buffer.from(value, 'base64url')
}
export function derivePairKeys(secret, binding) {
  if (!isUuid(binding.connection_id)) invalid()
  nonce(binding.sf_nonce); nonce(binding.og_nonce)
  const fields = ['connection_id', 'sf_owner_ref', 'og_owner_ref', 'sf_origin', 'og_origin'].map(key => {
    const value = binding[key]
    if (typeof value !== 'string' || !value.length || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) invalid()
    return value
  })
  const root = Buffer.from(hkdfSync('sha256', nonce(secret), createHash('sha256').update(binding.sf_nonce + '.' + binding.og_nonce).digest(), ['sparkygym-pair-v1', ...fields].join('\n'), 32))
  return {
    incoming: createHmac('sha256', root).update('sparkyfitness-to-opengym').digest(),
    outgoing: createHmac('sha256', root).update('opengym-to-sparkyfitness').digest(),
  }
}
const encryptionKey = root => Buffer.from(hkdfSync('sha256', Buffer.from(root), Buffer.alloc(0), 'sparkygym-credentials-v1', 32))
export function sealCredentials(root, connectionId, credentials) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(root), iv)
  cipher.setAAD(Buffer.from(connectionId))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()])
  return { iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }
}
export function openCredentials(root, connectionId, sealed) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(root), Buffer.from(sealed.iv, 'base64url'))
  decipher.setAAD(Buffer.from(connectionId)); decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64url')), decipher.final()]).toString('utf8'))
}
