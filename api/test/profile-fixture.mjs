import { join } from 'node:path';
import { openIntegrationStore } from '../storage/integration-store.js';

export function readProfile(dataDir, uid) {
  const store = openIntegrationStore(join(dataDir, 'profiles.sqlite'));
  try { return store.getProfile(uid)?.state; }
  finally { store.close(); }
}

export function writeProfile(dataDir, uid, state) {
  const store = openIntegrationStore(join(dataDir, 'profiles.sqlite'));
  try { return store.commitProfile(uid, store.getRevision(uid) ?? 0, state); }
  finally { store.close(); }
}

export function deleteProfile(dataDir, uid) {
  const store = openIntegrationStore(join(dataDir, 'profiles.sqlite'));
  try { return store.deleteProfile(uid); }
  finally { store.close(); }
}
