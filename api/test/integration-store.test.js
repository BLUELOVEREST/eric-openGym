import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { openIntegrationStore } from '../storage/integration-store.js'

const connection = '22222222-2222-4222-8222-222222222222'
const incoming = (revision = 1, id = '11111111-1111-4111-8111-111111111111') => Buffer.from(JSON.stringify({
  version: 1, event_id: id, connection_id: connection, producer: 'sparkyfitness',
  resource: 'body_measurement', entity_id: 'weight-1', revision, operation: 'upsert',
  occurred_at: '2026-10-29T06:00:00.000Z', payload: { value: 75.2, unit: 'kg' },
}))
const change = { connection_id: connection, resource: 'workout', entity_id: 'workout-1', operation: 'upsert', payload: { name: 'Training' } }

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-sqlite-'))
  const file = path.join(dir, 'gym.sqlite')
  const stores = []
  const open = () => { const store = openIntegrationStore(file); stores.push(store); return store }
  const store = open()
  store.commitProfile('owner', 0, { workouts: [] })
  store.createConnection('owner', { id: connection, peer_origin: 'https://health.example.com', peer_user_id: 'remote-owner', scopes: ['body_measurement', 'workout'] })
  store.activateConnection('owner', connection, { ciphertext: 'encrypted-fixture', iv: 'iv-fixture', tag: 'tag-fixture' })
  t.after(() => { for (const s of stores) s.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { store, open, file }
}

test('profile plus outgoing events commit atomically and survive restart', t => {
  const { store, open, file } = setup(t)
  const saved = store.commitProfile('owner', 1, { workouts: [{ id: 'workout-1' }] }, [change])
  assert.equal(saved.revision, 2)
  const queue = open().pending('owner')
  assert.equal(queue.length, 1)
  const event = JSON.parse(queue[0].body)
  assert.equal(event.producer, 'opengym')
  assert.equal(event.revision, 1)
  assert.equal(open().getProfile('owner').state.workouts.length, 1)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('an invalid queued event rolls back profile and revision allocation', t => {
  const { store } = setup(t)
  assert.throws(() => store.commitProfile('owner', 1, { workouts: [{ id: 'lost' }] }, [change, { ...change, resource: 'body_measurement' }]))
  assert.deepEqual(store.getProfile('owner'), { revision: 1, state: { workouts: [] } })
  assert.deepEqual(store.pending('owner'), [])
  store.commitProfile('owner', 1, { workouts: [] }, [change])
  assert.equal(JSON.parse(store.pending('owner')[0].body).revision, 1)
})

test('two database handles enforce compare-and-swap without lost updates', t => {
  const { store, open } = setup(t)
  const other = open()
  store.commitProfile('owner', 1, { workouts: [{ id: 'one' }] })
  assert.throws(() => other.commitProfile('owner', 1, { workouts: [{ id: 'two' }] }), /profile_conflict/)
  assert.equal(other.getProfile('owner').state.workouts[0].id, 'one')
})

test('inbox and business projection are one transaction; duplicate never reapplies', t => {
  const { store, open } = setup(t)
  let applied = 0
  const apply = tx => { applied++; tx.putProfile({ workouts: [], value: 75.2 }) }
  assert.equal(store.receive('owner', incoming(), apply).status, 'applied')
  assert.equal(open().receive('owner', incoming(), apply).status, 'duplicate')
  assert.equal(applied, 1)
  assert.equal(open().getProfile('owner').state.value, 75.2)
})

test('failed projection has no receipt and can be retried successfully', t => {
  const { store } = setup(t)
  assert.throws(() => store.receive('owner', incoming(), tx => {
    tx.putProfile({ lost: true }); throw new Error('projection failed')
  }), /projection failed/)
  assert.deepEqual(store.getProfile('owner').state, { workouts: [] })
  assert.equal(store.receive('owner', incoming(), tx => tx.putProfile({ restored: true })).status, 'applied')
})

test('older revisions are stale; equal revisions or altered event replays conflict', t => {
  const { store } = setup(t)
  store.receive('owner', incoming(3), tx => tx.putProfile({ newest: 3 }))
  assert.equal(store.receive('owner', incoming(1, '33333333-3333-4333-8333-333333333333'), () => assert.fail('stale projection')).status, 'stale')
  assert.throws(() => store.receive('owner', incoming(3, '44444444-4444-4444-8444-444444444444'), () => {}), /event_conflict/)
  assert.throws(() => store.receive('owner', Buffer.from(incoming(3).toString() + ' '), () => {}), /event_conflict/)
  assert.equal(store.getProfile('owner').state.newest, 3)
})

test('connections are pending by default and never leak encrypted keys through public state', t => {
  const { store } = setup(t)
  assert.equal('_sparkygym' in store.getProfile('owner').state, false)
  const second = '55555555-5555-4555-8555-555555555555'
  store.createConnection('owner', { id: second, peer_origin: 'https://peer.example.com', peer_user_id: 'remote', scopes: ['workout'] })
  assert.throws(() => store.commitProfile('owner', 1, {}, [{ ...change, connection_id: second }]), /connection_inactive/)
  assert.throws(() => store.commitProfile('owner', 1, { _sparkygym: {} }), /private_state_forbidden/)
})

test('owner, scopes, direction and revocation are enforced at persistence boundary', t => {
  const { store } = setup(t)
  store.commitProfile('other', 0, {})
  assert.throws(() => store.receive('other', incoming(), () => {}), /connection_unavailable/)
  assert.throws(() => store.commitProfile('other', 1, {}, [change]), /connection_unavailable/)
  const badScope = JSON.parse(incoming()); badScope.resource = 'body_goal'
  assert.throws(() => store.receive('owner', Buffer.from(JSON.stringify(badScope)), () => {}), /scope_denied/)
  const badDirection = JSON.parse(incoming()); badDirection.producer = 'opengym'; badDirection.resource = 'workout'
  assert.throws(() => store.receive('owner', Buffer.from(JSON.stringify(badDirection)), () => {}), /direction_denied/)
  store.revokeConnection('owner', connection)
  assert.throws(() => store.receive('owner', incoming(), () => {}), /connection_inactive/)
  assert.deepEqual(store.pending('owner'), [])
})

test('queue retry and acknowledgement are durable and validate event identity', t => {
  const { store, open } = setup(t)
  store.commitProfile('owner', 1, {}, [change])
  const row = store.pending('owner')[0]
  const event = JSON.parse(row.body)
  store.retry('owner', event.event_id, Date.now() + 60_000, 'receiver_unavailable')
  assert.deepEqual(open().pending('owner'), [])
  const due = open().pending('owner', Date.now() + 120_000)
  assert.equal(due[0].attempts, 1)
  assert.throws(() => store.acknowledge('owner', event.event_id, { version: 1, event_id: connection, status: 'applied', revision: 1 }), /invalid_receipt/)
  store.acknowledge('owner', event.event_id, { version: 1, event_id: event.event_id, status: 'applied', revision: 1 })
  assert.deepEqual(open().pending('owner', Date.now() + 120_000), [])
  store.commitProfile('owner', 2, {}, [change])
  assert.equal(JSON.parse(store.pending('owner')[0].body).revision, 2)
})

test('async, reentrant and escaped callbacks cannot write after a transaction', t => {
  const { store } = setup(t)
  let escaped
  assert.throws(() => store.receive('owner', incoming(), async () => {}), /synchronous_required/)
  assert.throws(() => store.receive('owner', incoming(), () => store.commitProfile('owner', 1, {})), /nested_transaction/)
  store.receive('owner', incoming(), tx => { escaped = tx; tx.putProfile({ ok: true }) })
  assert.throws(() => escaped.putProfile({ late: true }), /transaction_closed/)
  assert.equal(store.getProfile('owner').state.ok, true)
})

test('corrupt files fail rather than falling back to JSON', t => {
  const { file, store } = setup(t)
  store.close()
  fs.writeFileSync(file + '.json', '{"workouts":[{"id":"shadow"}]}')
  fs.writeFileSync(file, 'not a sqlite database')
  assert.throws(() => openIntegrationStore(file))
})

test('unknown schema versions fail without resetting or overwriting data', t => {
  const { store, file } = setup(t)
  store.close()
  const db = new DatabaseSync(file)
  db.exec('PRAGMA user_version=99')
  db.close()
  assert.throws(() => openIntegrationStore(file), /unsupported_database_version/)
  const check = new DatabaseSync(file)
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99)
  assert.equal(JSON.parse(check.prepare('SELECT state FROM profiles').get().state).workouts.length, 0)
  check.close()
})

test('a killed receiver rolls back its business write and receipt together', t => {
  const { store, file } = setup(t)
  const moduleUrl = new URL('../storage/integration-store.js', import.meta.url).href
  const script = `import {openIntegrationStore} from ${JSON.stringify(moduleUrl)};
    const s=openIntegrationStore(${JSON.stringify(file)});
    s.receive('owner',Buffer.from(${JSON.stringify(incoming().toString())}),tx=>{
      tx.putProfile({crashed:true}); process.kill(process.pid,'SIGKILL');
    });`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 })
  assert.equal(result.signal, 'SIGKILL', result.stderr.toString())
  assert.deepEqual(store.getProfile('owner').state, { workouts: [] })
  assert.equal(store.receive('owner', incoming(), tx => tx.putProfile({ recovered: true })).status, 'applied')
})

test('a committed profile and event survive SIGKILL without explicit database close', t => {
  const { open, file } = setup(t)
  const moduleUrl = new URL('../storage/integration-store.js', import.meta.url).href
  const script = `import {openIntegrationStore} from ${JSON.stringify(moduleUrl)};
    const s=openIntegrationStore(${JSON.stringify(file)});
    s.commitProfile('owner',1,{committed:true},[${JSON.stringify(change)}]);
    process.kill(process.pid,'SIGKILL');`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 })
  assert.equal(result.signal, 'SIGKILL', result.stderr.toString())
  assert.equal(open().getProfile('owner').state.committed, true)
  assert.equal(open().pending('owner').length, 1)
})

test('plain callbacks returning a promise are rolled back and their context expires', t => {
  const { store } = setup(t)
  let escaped
  assert.throws(() => store.receive('owner', incoming(), tx => {
    escaped = tx; tx.putProfile({ lost: true }); return Promise.resolve()
  }), /synchronous_required/)
  assert.throws(() => escaped.putProfile({ late: true }), /transaction_closed/)
  assert.deepEqual(store.getProfile('owner').state, { workouts: [] })
})

test('nonfinite and non-JSON profile data are rejected rather than silently converted', t => {
  const { store } = setup(t)
  for (const state of [{ value: NaN }, { value: Infinity }, { value: undefined }, { value: new Map() }]) {
    assert.throws(() => store.commitProfile('owner', 1, state), /invalid_json/)
  }
  assert.equal(store.getProfile('owner').revision, 1)
})

test('plain HTTP peers require explicit opt-in and credentials cannot contain plaintext extras', t => {
  const { store } = setup(t)
  const input = { id: '55555555-5555-4555-8555-555555555555', peer_origin: 'http://192.168.200.118:3016', peer_user_id: 'remote', scopes: ['body_measurement'] }
  assert.throws(() => store.createConnection('owner', input), /invalid_connection/)
  store.createConnection('owner', { ...input, allow_insecure_http: true })
  assert.throws(() => store.activateConnection('owner', input.id, { ciphertext: 'cipher', iv: 'iv', tag: 'tag', plaintext: 'must-not-persist' }), /sealed_keys_required/)
})

test('callbacks cannot change event identity or revision after envelope validation', t => {
  const { store } = setup(t)
  for (const [key, value] of Object.entries({ revision: 0, entity_id: 'other', event_id: connection, connection_id: 'changed', resource: 'body_goal' })) {
    assert.throws(() => store.receive('owner', incoming(), (tx, event) => {
      tx.putProfile({ lost: true }); event[key] = value
    }), TypeError)
    assert.deepEqual(store.getProfile('owner').state, { workouts: [] })
  }
  assert.equal(store.receive('owner', incoming(), tx => tx.putProfile({ accepted: true })).revision, 1)
})

test('rejected promise callbacks do not cause fatal unhandled rejections', t => {
  const { store, file } = setup(t)
  const moduleUrl = new URL('../storage/integration-store.js', import.meta.url).href
  const script = `import {openIntegrationStore} from ${JSON.stringify(moduleUrl)};
    import assert from 'node:assert/strict';
    const s=openIntegrationStore(${JSON.stringify(file)});
    assert.throws(()=>s.receive('owner',Buffer.from(${JSON.stringify(incoming().toString())}),
      tx=>{tx.putProfile({lost:true});return Promise.reject(new Error('async failure'));}),/synchronous_required/);
    setImmediate(()=>s.close());`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr.toString())
  assert.deepEqual(store.getProfile('owner').state, { workouts: [] })
})

test('serialization hooks cannot replace a validated profile, and accessors are rejected', t => {
  const { store } = setup(t)
  const state = { workouts: [] }
  Object.defineProperty(state, 'toJSON', { value: () => ({ _sparkygym: { secret: 'unexpected' } }) })
  store.commitProfile('owner', 1, state)
  assert.deepEqual(store.getProfile('owner').state, { workouts: [] })
  const accessor = { get workouts() { return [] } }
  assert.throws(() => store.commitProfile('owner', 2, accessor), /invalid_json/)
})
