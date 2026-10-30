import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { openIntegrationStore } from './integration-store.js'
import { STORE_FILENAME } from './profile-reader.js'
import { syncDirectory } from './file-sync.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const legacyName = /^state-([a-zA-Z0-9_-]+)\.json$/

function privateCopy(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  if (digest(fs.readFileSync(file)) !== digest(bytes)) throw new Error('profile_backup_verification_failed')
}

function readLegacy(dataDir, users) {
  const owners = new Set()
  for (const user of users) {
    if (!user || typeof user.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(user.id) || owners.has(user.id)) {
      throw new Error('legacy_profile_owner_invalid')
    }
    owners.add(user.id)
  }
  const profiles = []
  for (const name of fs.readdirSync(dataDir).filter(name => name.startsWith('state-') && name.endsWith('.json')).sort()) {
    const match = legacyName.exec(name)
    if (!match || !owners.has(match[1])) throw new Error(`legacy_profile_owner_unknown: ${name}`)
    const file = path.join(dataDir, name)
    if (!fs.lstatSync(file).isFile()) throw new Error(`legacy_profile_file_invalid: ${name}`)
    const bytes = fs.readFileSync(file)
    const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error(`legacy_profile_invalid: ${name}`)
    profiles.push({ owner_id: match[1], name, bytes, sha256: digest(bytes), state })
  }
  return profiles
}

function archiveLegacy(dataDir, store, marker) {
  if (marker?.version !== 1 || typeof marker.archive_complete !== 'boolean' ||
    !/^legacy-profile-backup-[0-9a-f-]{36}$/.test(marker.backup_directory) || !Array.isArray(marker.profiles)) {
    throw new Error('profile_migration_marker_invalid')
  }
  if (marker.archive_complete) return
  const backupDir = path.join(dataDir, marker.backup_directory)
  const retiredDir = path.join(backupDir, 'retired')
  fs.mkdirSync(retiredDir, { mode: 0o700, recursive: true })
  for (const entry of marker.profiles) {
    if (typeof entry.name !== 'string' || !legacyName.test(entry.name) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error('profile_migration_marker_invalid')
    }
    const backup = fs.readFileSync(path.join(backupDir, entry.name))
    if (digest(backup) !== entry.sha256) throw new Error('profile_backup_verification_failed')
    const source = path.join(dataDir, entry.name)
    const retired = path.join(retiredDir, entry.name)
    let sourceStat
    try { sourceStat = fs.lstatSync(source) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!sourceStat.isFile() || digest(fs.readFileSync(source)) !== entry.sha256) throw new Error('legacy_profile_changed_during_migration')
    if (fs.existsSync(retired)) throw new Error('legacy_profile_archive_conflict')
    fs.renameSync(source, retired)
  }
  syncDirectory(retiredDir)
  syncDirectory(backupDir)
  syncDirectory(dataDir)
  store.completeProfileArchive()
}

// Startup only, with the old API stopped. After the commit marker exists, legacy
// JSON is never reimported and SQL failures never trigger a file-backed fallback.
export function initializeProfileStorage(dataDir, { users }) {
  const store = openIntegrationStore(path.join(dataDir, STORE_FILENAME))
  try {
    let marker = store.getProfileMigration()
    if (!marker) {
      if (store.listProfiles().length) throw new Error('migration_target_not_empty')
      const profiles = readLegacy(dataDir, users)
      const backupDirectory = `legacy-profile-backup-${randomUUID()}`
      const backupDir = path.join(dataDir, backupDirectory)
      fs.mkdirSync(backupDir, { mode: 0o700 })
      const files = []
      for (const profile of profiles) {
        privateCopy(path.join(backupDir, profile.name), profile.bytes)
        files.push({ name: profile.name, sha256: profile.sha256, bytes: profile.bytes.length })
      }
      for (const name of ['db.json', 'db.json.bak']) {
        try {
          const auth = fs.readFileSync(path.join(dataDir, name))
          privateCopy(path.join(backupDir, name), auth)
          files.push({ name, sha256: digest(auth), bytes: auth.length })
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      privateCopy(path.join(backupDir, 'manifest.json'), Buffer.from(JSON.stringify({ version: 1, files }, null, 2)))
      syncDirectory(backupDir)
      syncDirectory(dataDir)
      for (const profile of profiles) {
        if (digest(fs.readFileSync(path.join(dataDir, profile.name))) !== profile.sha256) throw new Error('legacy_profile_changed_during_migration')
      }
      marker = {
        version: 1, archive_complete: false, backup_directory: backupDirectory,
        profiles: profiles.map(({ name, sha256, owner_id }) => ({ name, sha256, owner_id })),
      }
      store.importProfiles(profiles, marker)
    }
    archiveLegacy(dataDir, store, marker)
    return store
  } catch (error) { store.close(); throw error }
}
