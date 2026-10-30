import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { boundPort } from './helpers.mjs'
import { openIntegrationStore } from '../storage/integration-store.js'

const secret = 'd'.repeat(64)
const uid = 'u_native', admin = 'u_admin'
function headers(user = uid) {
  const body = `${user}:${Date.now() + 86400000}:0`
  const token = `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`
  return { Cookie: `gymsid=${token}`, Origin: 'http://localhost:8080', 'Content-Type': 'application/json' }
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-native-server-'))
  const children = []
  fs.writeFileSync(path.join(dir, 'secret'), secret)
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: [{ id: uid, name: 'Native' }, { id: admin, name: 'Admin', admin: true }], creds: [], subs: [], invites: [] }))
  fs.writeFileSync(path.join(dir, `state-${uid}.json`), JSON.stringify({ _rev: 37, workouts: [{ id: 'before' }], routines: [] }))
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, async start({ preload } = {}) {
    const args = preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'server.js'] : ['server.js']
    const child = spawn(process.execPath, args, { cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: '0', DATA_DIR: dir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' } })
    children.push(child)
    let log = ''
    child.stdout.on('data', chunk => { log += chunk })
    child.stderr.on('data', chunk => { log += chunk })
    const port = await boundPort(child, () => log)
    return { child, base: `http://127.0.0.1:${port}` }
  } }
}

test('real API imports once, writes only SQLite and ignores regenerated legacy JSON', async t => {
  const { dir, start } = fixture(t)
  const { base } = await start()
  const before = await (await fetch(`${base}/api/data`, { headers: headers() })).json()
  assert.equal(before.rev, 37)
  assert.equal(fs.existsSync(path.join(dir, `state-${uid}.json`)), false)
  const response = await fetch(`${base}/api/data`, { method: 'PUT', headers: headers(), body: JSON.stringify({ baseRev: 37, state: { ...before.state, workouts: [{ id: 'after' }] } }) })
  assert.equal(response.status, 200)
  const store = openIntegrationStore(path.join(dir, 'profiles.sqlite'))
  try { assert.equal(store.getProfile(uid).state.workouts[0].id, 'after') } finally { store.close() }
  assert.equal(fs.existsSync(path.join(dir, `state-${uid}.json`)), false)
  fs.writeFileSync(path.join(dir, `state-${uid}.json`), 'corrupt, ignored, never a fallback')
  const after = await (await fetch(`${base}/api/data`, { headers: headers() })).json()
  assert.equal(after.state.workouts[0].id, 'after')
})

test('cached API reads observe native SQL revisions from another connection', async t => {
  const { dir, start } = fixture(t)
  const { base } = await start()
  assert.equal((await (await fetch(`${base}/api/data/rev`, { headers: headers() })).json()).rev, 37)
  const store = openIntegrationStore(path.join(dir, 'profiles.sqlite'))
  try {
    const row = store.getProfile(uid)
    store.commitProfile(uid, row.revision, { ...row.state, _rev: 38, _wid: 'external', workouts: [{ id: 'external' }] })
  } finally { store.close() }
  const after = await (await fetch(`${base}/api/data/rev`, { headers: headers() })).json()
  assert.equal(after.rev, 38)
  assert.equal(after.wid, 'external')
})

test('account removal failure stays disabled and completes on the next startup', async t => {
  const { dir, start } = fixture(t)
  const { base, child } = await start()
  const db = new DatabaseSync(path.join(dir, 'profiles.sqlite'))
  db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON profiles BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END")
  const removed = await fetch(`${base}/api/admin/user/delete`, { method: 'POST', headers: headers(admin), body: JSON.stringify({ id: uid }) })
  assert.equal(removed.status, 500)
  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).users.find(user => user.id === uid)
  assert.equal(pending.disabled, true)
  assert.equal(pending.deletePending, true)
  const enabled = await fetch(`${base}/api/admin/user/disable`, { method: 'POST', headers: headers(admin), body: JSON.stringify({ id: uid, disabled: false }) })
  assert.equal(enabled.status, 409, 'a pending deletion cannot be cancelled by the enable command')
  assert.equal((await fetch(`${base}/api/me`, { headers: headers() })).status, 401)
  db.exec('DROP TRIGGER fail_delete')
  db.close()
  child.kill('SIGKILL'); await once(child, 'exit')
  await start()
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).users.some(user => user.id === uid), false)
  const store = openIntegrationStore(path.join(dir, 'profiles.sqlite'))
  try { assert.equal(store.getProfile(uid), null) } finally { store.close() }
})

test('API image includes every native storage and integration module it imports', () => {
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  assert.match(dockerfile, /^COPY storage \.\/storage$/m)
  assert.match(dockerfile, /^COPY integrations \.\/integrations$/m)
})

test('media cleanup failure retains the tombstone and restarts cleanup later', async t => {
  const { dir, start } = fixture(t)
  const uploads = path.join(dir, 'uploads', uid)
  fs.mkdirSync(uploads, { recursive: true })
  fs.writeFileSync(path.join(uploads, 'retained.txt'), 'personal fixture')
  const flag = path.join(dir, 'block-cleanup')
  fs.writeFileSync(flag, '')
  const preload = `import fs from 'node:fs'; const rm=fs.rmSync;
    fs.rmSync=(file,options)=>{
      if(file===${JSON.stringify(uploads)}&&fs.existsSync(${JSON.stringify(flag)})){
        const e=new Error('cleanup denied');e.code='EACCES';throw e;
      } return rm(file,options);
    };`
  const { base, child } = await start({ preload })
  const response = await fetch(`${base}/api/admin/user/delete`, { method: 'POST', headers: headers(admin), body: JSON.stringify({ id: uid }) })
  assert.equal(response.status, 500)
  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).users.find(user => user.id === uid)
  assert.equal(pending.deletePending, true)
  assert.equal((await fetch(`${base}/api/me`, { headers: headers() })).status, 401)
  assert.equal(fs.existsSync(uploads), true)
  fs.unlinkSync(flag)
  child.kill('SIGKILL'); await once(child, 'exit')
  await start()
  assert.equal(fs.existsSync(uploads), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).users.some(user => user.id === uid), false)
})

test('credential cleanup errors cannot turn account deletion into a false success', async t => {
  const { dir, start } = fixture(t)
  const credential = path.join(dir, `coach-auth-${uid}.json`)
  fs.writeFileSync(credential, '{"data":"fixture-credential"}')
  const preload = `import fs from 'node:fs'; const unlink=fs.unlinkSync;
    fs.unlinkSync=file=>{if(file===${JSON.stringify(credential)}){
      const e=new Error('credential cleanup denied');e.code='EACCES';throw e;
    }return unlink(file);};`
  const { base, child } = await start({ preload })
  const response = await fetch(`${base}/api/admin/user/delete`, { method: 'POST', headers: headers(admin), body: JSON.stringify({ id: uid }) })
  assert.equal(response.status, 500)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).users.find(user => user.id === uid).deletePending, true)
  assert.equal(fs.existsSync(credential), true)
  child.kill('SIGKILL'); await once(child, 'exit')
  await start()
  assert.equal(fs.existsSync(credential), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).users.some(user => user.id === uid), false)
})

test('a pending deletion does not count as an available second administrator', async t => {
  const { dir, start } = fixture(t)
  const registry = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'))
  registry.users.find(user => user.id === uid).admin = true
  registry.users.find(user => user.id === admin).owner = true
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(registry))
  const { base } = await start()
  const db = new DatabaseSync(path.join(dir, 'profiles.sqlite'))
  try {
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON profiles BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END")
    const removed = await fetch(`${base}/api/admin/user/delete`, { method: 'POST', headers: headers(admin), body: JSON.stringify({ id: uid }) })
    assert.equal(removed.status, 500)
    const info = await (await fetch(`${base}/api/account/passkeys`, { headers: headers(admin) })).json()
    assert.equal(info.deleteBlocked, 'last-admin')
  } finally { db.close() }
})

test('auth tombstone must be durably synced before profile cleanup begins', async t => {
  const { dir, start } = fixture(t)
  const flag = path.join(dir, 'block-auth-sync')
  const preload = `import fs from 'node:fs';const open=fs.openSync,close=fs.closeSync,sync=fs.fsyncSync,dirs=new Set();
    fs.openSync=(file,...args)=>{const fd=open(file,...args);if(file===${JSON.stringify(dir)})dirs.add(fd);return fd;};
    fs.closeSync=fd=>{dirs.delete(fd);return close(fd);};
    fs.fsyncSync=fd=>{if(dirs.has(fd)&&fs.existsSync(${JSON.stringify(flag)})){
      const e=new Error('auth directory sync failed');e.code='EIO';throw e;
    }return sync(fd);};`
  const { base } = await start({ preload })
  fs.writeFileSync(flag, '')
  const response = await fetch(`${base}/api/admin/user/delete`, { method: 'POST', headers: headers(admin), body: JSON.stringify({ id: uid }) })
  assert.equal(response.status, 500)
  const store = openIntegrationStore(path.join(dir, 'profiles.sqlite'))
  try { assert.notEqual(store.getProfile(uid), null, 'do not destroy data before durable authentication revocation') }
  finally { store.close() }
})
