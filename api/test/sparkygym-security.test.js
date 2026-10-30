import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, hkdfSync } from 'node:crypto'
import { derivePairKeys, sealCredentials, openCredentials, signControl, verifyControl, signResponse, verifyResponse } from '../integrations/sparkygym-security.js'
import { validateDestination } from '../integrations/sparkygym-transport.js'

const binding = { connection_id: '22222222-2222-4222-8222-222222222222', sf_owner_ref: 'sf', og_owner_ref: 'og', sf_origin: 'https://sf.example', og_origin: 'https://og.example', sf_nonce: Buffer.alloc(32, 1).toString('base64url'), og_nonce: Buffer.alloc(32, 2).toString('base64url') }
test('pair derivation matches the specified HKDF and directional HMACs exactly', () => {
  const secret = Buffer.alloc(32, 3).toString('base64url')
  const root = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'base64url'), createHash('sha256').update(binding.sf_nonce + '.' + binding.og_nonce).digest(), ['sparkygym-pair-v1', ...['connection_id', 'sf_owner_ref', 'og_owner_ref', 'sf_origin', 'og_origin'].map(k => binding[k])].join('\n'), 32))
  const keys = derivePairKeys(secret, binding)
  assert.deepEqual(keys.incoming, createHmac('sha256', root).update('sparkyfitness-to-opengym').digest())
  assert.deepEqual(keys.outgoing, createHmac('sha256', root).update('opengym-to-sparkyfitness').digest())
  assert.throws(() => derivePairKeys('short', binding))
})
test('credentials are encrypted with purpose and binding authenticated', () => {
  const sealed = sealCredentials('persistent-secret', binding.connection_id, { incoming: 'secret' })
  assert.equal(JSON.stringify(sealed).includes('secret'), false)
  assert.deepEqual(openCredentials('persistent-secret', binding.connection_id, sealed), { incoming: 'secret' })
  assert.throws(() => openCredentials('other', binding.connection_id, sealed))
  assert.throws(() => openCredentials('persistent-secret', 'other-connection', sealed))
})
test('fixed-path control and receipt signatures bind exact bytes, time, and request identity', () => {
  const body = Buffer.from('{"a":1}'), key = Buffer.alloc(32, 4), id = binding.connection_id + '_og', timestamp = '1000'
  const requestId = binding.connection_id
  const signature = signControl('POST', '/api/integrations/v1/pair/claim', body, id, timestamp, key, requestId)
  assert.equal(signature, 'v1=f3e8415c8684a05875997f1906f0f61491dfbf723db1f546e802992ee5b677c3')
  assert.equal(verifyControl('POST', '/api/integrations/v1/pair/claim', body, id, timestamp, signature, key, requestId, 1000), true)
  assert.equal(verifyControl('POST', '/api/integrations/v1/pair/accept', body, id, timestamp, signature, key, requestId, 1000), false)
  assert.equal(verifyControl('POST', '/api/integrations/v1/pair/claim', Buffer.concat([body, Buffer.from(' ')]), id, timestamp, signature, key, requestId, 1000), false)
  assert.equal(verifyControl('POST', '/api/integrations/v1/pair/claim', body, id, timestamp, signature, key, requestId, 1301), false)
  const other = '33333333-3333-4333-8333-333333333333'
  assert.notEqual(signControl('POST', '/api/integrations/v1/pair/claim', body, id, timestamp, key, other), signature)
  assert.equal(verifyControl('POST', '/api/integrations/v1/pair/claim', body, id, timestamp, signature, key, other, 1000), false)
  assert.throws(() => signControl('PUT', '/api/data', body, id, timestamp, key, requestId))
  const receipt = signResponse('request-1', 200, body, id, timestamp, key)
  assert.equal(verifyResponse('request-1', 200, body, id, timestamp, receipt, key, 1000), true)
  assert.equal(verifyResponse('request-2', 200, body, id, timestamp, receipt, key, 1000), false)
})
test('destination validation checks every address and separate HTTP/private opt-ins', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]
  await assert.rejects(validateDestination('https://example.com', {}, lookup), /private_destination/)
  await assert.rejects(validateDestination('http://192.168.1.2', { allow_private_network: true }), /insecure_http/)
  assert.equal((await validateDestination('http://192.168.1.2', { allow_private_network: true, allow_insecure_http: true })).addresses[0].address, '192.168.1.2')
  for (const address of ['169.254.169.254', '0.0.0.0', '224.0.0.1', '[::]', '[fe80::1]', '[ff02::1]', '[::ffff:169.254.169.254]']) {
    await assert.rejects(validateDestination(new URL('http://' + address).origin, { allow_private_network: true, allow_insecure_http: true }), /blocked_destination/)
  }
  await assert.rejects(validateDestination('https://user:password@example.com'), /invalid_origin/)
})
