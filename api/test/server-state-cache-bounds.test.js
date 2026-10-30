/* Parsed SQL profile states are bounded by LRU capacity and idle TTL. A child-only JSON.parse
   probe observes real cache misses without relying on legacy files or timestamp granularity. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { writeProfile } from './profile-fixture.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const PROBE = 'u_cache_probe';
// One more than the cap, so polling all of them pushes exactly one entry — the probe's — out.
const FILLERS = Array.from({ length: 64 }, (_, i) => `u_cache_${i}`);

const mint = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const headers = uid => ({ Cookie: `gymsid=${mint(uid)}` });

async function startServer(t, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-cachebound-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const users = [PROBE, ...FILLERS].map(id => ({ id, name: id, created: new Date().toISOString() }));
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users, creds: [], subs: [], invites: [] }));
  // Legacy fixtures are imported at boot; each filler needs a stored profile to be cached.
  for (const uid of FILLERS) fs.writeFileSync(path.join(dataDir, `state-${uid}.json`), JSON.stringify({ _rev: 1, workouts: [], routines: [] }));
  const probe = `const parse = JSON.parse; JSON.parse = function (...args) {
    const value = Reflect.apply(parse, this, args);
    if (value?._cacheProbe === '${PROBE}') console.log('PROFILE_PARSE');
    return value;
  };`;
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(probe)}`, 'server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ...env }
  });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const port = await boundPort(child, () => log);
  return { api: `http://127.0.0.1:${port}`, dataDir,
    parses: async () => {
      // stdout and HTTP use different pipes; drain the probe before comparing counts.
      await new Promise(r => setTimeout(r, 50));
      return (log.match(/^PROFILE_PARSE$/gm) || []).length;
    } };
}

const seedProbe = dir => writeProfile(dir, PROBE, { _rev: 1, _cacheProbe: PROBE, lang: 'en', workouts: [], routines: [] });

test('the cache holds at most 64 users, and the least recently polled is the one dropped', async t => {
  const h = await startServer(t);
  const rev = async uid => (await fetch(`${h.api}/api/data/rev`, { headers: headers(uid) }).then(r => r.json())).rev;

  seedProbe(h.dataDir);
  await rev(PROBE);
  const first = await h.parses();
  assert.ok(first > 0, 'the probe observes actual SQL state parsing');
  await rev(PROBE);
  assert.equal(await h.parses(), first, 'an unchanged SQL revision reuses parsed state');

  // 64 other people poll once each. That is one more entry than the cap allows alongside the
  // probe's, and the probe's is the one nobody has touched since.
  for (const uid of FILLERS) await rev(uid);

  await rev(PROBE);
  assert.equal(await h.parses(), first + 1, 'the least recently used profile was evicted and parsed again');
});

test('an entry nobody has polled for longer than the TTL is dropped', async t => {
  const h = await startServer(t, { STATE_CACHE_TTL_MS: '500' });
  const rev = async uid => (await fetch(`${h.api}/api/data/rev`, { headers: headers(uid) }).then(r => r.json())).rev;

  seedProbe(h.dataDir);
  await rev(PROBE);
  const first = await h.parses();
  assert.ok(first > 0, 'the probe observes actual SQL state parsing');
  await rev(PROBE);
  assert.equal(await h.parses(), first, 'still inside the TTL, no repeated SQL state parse');

  await new Promise(r => setTimeout(r, 700));
  await rev(PROBE);
  assert.equal(await h.parses(), first + 1, 'past the TTL, the profile is parsed again');
});
