import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initializeProfileStorage } from '../storage/profile-migration.js';
import { tempData, sampleState } from './helpers.mjs';

const dir = tempData();
// Importing jobs must not open storage before the server's importer has run.
const jobs = await import('../coach/jobs.js');

test('profile reads fail closed before migration, without using legacy JSON', () => {
  fs.writeFileSync(path.join(dir, 'state-legacy.json'), JSON.stringify(sampleState()));
  assert.throws(() => jobs.readState('legacy'));
  assert.throws(() => jobs.listUserIds());
  assert.equal(fs.existsSync(path.join(dir, 'profiles.sqlite')), false);
});

test('lazy reader sees SQL commits, ignores legacy JSON, and preserves missing profiles', () => {
  fs.unlinkSync(path.join(dir, 'state-legacy.json'));
  const store = initializeProfileStorage(dir, { users: [] });
  fs.writeFileSync(path.join(dir, 'state-legacy.json'), JSON.stringify(sampleState()));
  try {
    const state = sampleState();
    store.commitProfile('native', 0, state);
    assert.deepEqual(jobs.listUserIds(), ['native']);
    assert.deepEqual(jobs.readState('native'), state);
    assert.equal(jobs.readState('legacy'), null);
    assert.equal(jobs.readState('missing'), null);
    const revoked = sampleState({ coach: {} });
    store.commitProfile('native', 1, revoked);
    assert.deepEqual(jobs.readState('native'), revoked);
    // No sanitization aliases one authenticated owner to another.
    assert.equal(jobs.readState('native/'), null);
  } finally { store.close(); }
});
