import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, createHmac } from 'node:crypto'
import { parseEvent, parseReceipt, signRequest, verifyRequest } from '../integrations/sparkygym-protocol.js'

const event = {
  version: 1,
  event_id: '11111111-1111-4111-8111-111111111111',
  connection_id: '22222222-2222-4222-8222-222222222222',
  producer: 'sparkyfitness', resource: 'body_measurement', entity_id: 'weight-1', revision: 1,
  operation: 'upsert', occurred_at: '2026-10-29T06:00:00.000Z',
  payload: { name: '体重', value: 75.2, unit: 'kg' },
}
const raw = Buffer.from(JSON.stringify(event))
const secret = Buffer.alloc(32, 7)
const timestamp = '1793253600'
const now = Number(timestamp)
const keyId = 'key_1'

test('accepts durable receipts, not queued or malformed acknowledgements', () => {
  const receipt = { version: 1, event_id: event.event_id, status: 'applied', revision: 1 }
  for (const status of ['applied', 'duplicate', 'stale']) assert.deepEqual(parseReceipt({ ...receipt, status }), { ...receipt, status })
  for (const patch of [{ status: 'queued' }, { revision: 0 }, { extra: true }, { version: 2 }]) assert.throws(() => parseReceipt({ ...receipt, ...patch }))
  assert.throws(() => parseReceipt(null))
})

test('accepts body, training and delete envelopes without data loss', () => {
  assert.deepEqual(parseEvent(raw), event)
  for (const patch of [
    { producer: 'opengym', resource: 'workout' },
    { operation: 'delete', payload: null },
  ]) assert.deepEqual(parseEvent(Buffer.from(JSON.stringify({ ...event, ...patch }))), { ...event, ...patch })
})

for (const patch of [
  { revision: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { version: 2 },
  { event_id: 'not-a-uuid' }, { occurred_at: '2026-02-30T06:00:00.000Z' },
  { occurred_at: '2026-10-29T06:00:00+00:00' }, { entity_id: '\n' },
  { entity_id: 'x'.repeat(201) }, { producer: 'opengym' }, { resource: 'statistics' },
  { payload: null }, { payload: [] }, { extra: true }, { user_id: 'untrusted-user' },
  { operation: 'delete' },
  { resource: ['body_measurement'] }, { resource: 'constructor' },
]) test(`rejects invalid envelope ${JSON.stringify(patch)}`, () => {
  assert.throws(() => parseEvent(Buffer.from(JSON.stringify({ ...event, ...patch }))))
})

test('rejects invalid UTF-8, nonfinite JSON and oversized bodies', () => {
  assert.throws(() => parseEvent(Buffer.from([0xff])))
  assert.throws(() => parseEvent(Buffer.from(JSON.stringify(event).replace('75.2', '1e999'))))
  assert.throws(() => parseEvent(Buffer.alloc(1_048_577)))
})

test('signatures bind bytes, key ID, timestamp, key and inclusive skew', () => {
  const signature = signRequest(raw, keyId, timestamp, secret)
  assert.equal(signature, 'v1=f4312fefbcbc2841c9094db274625c855e533e2bbb5ff93ee607b34dc89a42b9')
  assert.match(signature, /^v1=[a-f0-9]{64}$/)
  for (const offset of [-300, 0, 300]) assert.equal(verifyRequest(raw, keyId, timestamp, signature, secret, now + offset), true)
  for (const offset of [-301, 301]) assert.equal(verifyRequest(raw, keyId, timestamp, signature, secret, now + offset), false)
  assert.equal(verifyRequest(Buffer.from(`${raw.toString()} `), keyId, timestamp, signature, secret, now), false)
  assert.equal(verifyRequest(raw, 'other', timestamp, signature, secret, now), false)
  assert.equal(verifyRequest(raw, keyId, String(now + 1), signature, secret, now), false)
  assert.equal(verifyRequest(raw, keyId, timestamp, signature, Buffer.alloc(32, 8), now), false)
})

test('rejects MACs generated for another path or method', () => {
  for (const [method, path] of [['GET', '/api/integrations/v1/events'], ['POST', '/api/data']]) {
    const input = ['sparkygym-v1', method, path, timestamp, keyId, createHash('sha256').update(raw).digest('hex')].join('\n')
    const signature = `v1=${createHmac('sha256', secret).update(input).digest('hex')}`
    assert.equal(verifyRequest(raw, keyId, timestamp, signature, secret, now), false)
  }
})

test('fails closed for malformed authentication framing', () => {
  for (const signature of [undefined, '', 'v1=00', 'v2=' + 'a'.repeat(64), 'v1=' + 'A'.repeat(64)]) {
    assert.equal(verifyRequest(raw, keyId, timestamp, signature, secret, now), false)
  }
  const signature = signRequest(raw, keyId, timestamp, secret)
  assert.equal(verifyRequest(raw, keyId, 'NaN', signature, secret, now), false)
  assert.equal(verifyRequest(raw, keyId, timestamp, signature, secret, NaN), false)
  assert.equal(verifyRequest(raw, 'key\n1', timestamp, signature, secret, now), false)
  assert.equal(verifyRequest(raw, keyId, timestamp, signature, Buffer.alloc(0), now), false)
  assert.throws(() => signRequest(raw, keyId, timestamp, Buffer.alloc(31)))
})
