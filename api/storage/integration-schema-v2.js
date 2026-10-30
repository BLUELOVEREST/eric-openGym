export const INTEGRATION_SCHEMA_V2 = `
ALTER TABLE connections ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1));
ALTER TABLE connections ADD COLUMN allow_private_network INTEGER NOT NULL DEFAULT 0 CHECK(allow_private_network IN (0,1));
ALTER TABLE connections ADD COLUMN binding TEXT CHECK(binding IS NULL OR json_valid(binding));
CREATE TABLE body_sources (
 owner_id TEXT PRIMARY KEY REFERENCES profiles(owner_id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES connections(id),
 source_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE body_entities (
 owner_id TEXT NOT NULL REFERENCES profiles(owner_id) ON DELETE CASCADE,
 source_id TEXT NOT NULL,
 resource TEXT NOT NULL CHECK(resource IN ('body_definition','body_measurement','body_goal')),
 entity_id TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 PRIMARY KEY(owner_id,source_id,resource,entity_id)
) STRICT;
CREATE TABLE native_body_archive (
 archive_id INTEGER PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES profiles(owner_id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL,
 archived_at TEXT NOT NULL,
 body_values TEXT NOT NULL CHECK(json_valid(body_values))
) STRICT;
CREATE TABLE integration_notifications (
 cursor INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL REFERENCES profiles(owner_id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload))
) STRICT;
CREATE INDEX integration_notifications_owner ON integration_notifications(owner_id,cursor);
CREATE TABLE integration_controls (
 request_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES profiles(owner_id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
 method TEXT NOT NULL,
 path TEXT NOT NULL,
 body BLOB NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','terminal')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0
) STRICT;
PRAGMA user_version=2;
`
export const INTEGRATION_SCHEMA_V3 = `
ALTER TABLE outbox ADD COLUMN source_cursor INTEGER;
CREATE UNIQUE INDEX outbox_source_cursor ON outbox(source_cursor);
ALTER TABLE body_entities ADD COLUMN last_source_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE body_sources ADD COLUMN source_cursor INTEGER NOT NULL DEFAULT 0;
INSERT INTO storage_metadata(key,value) VALUES('outgoing_source_cursor','0');
CREATE TABLE integration_control_inbox (
 connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL,
 method TEXT NOT NULL,
 path TEXT NOT NULL,
 body_hash TEXT NOT NULL,
 response TEXT NOT NULL CHECK(json_valid(response)),
 PRIMARY KEY(connection_id,request_id)
) STRICT;
PRAGMA user_version=3;
`
export const INTEGRATION_SCHEMA_V4 = `
ALTER TABLE outbox ADD COLUMN delivery_order INTEGER;
ALTER TABLE integration_controls ADD COLUMN delivery_order INTEGER;
UPDATE integration_controls SET delivery_order=rowid;
UPDATE outbox SET delivery_order=rowid+(SELECT COALESCE(MAX(delivery_order),0) FROM integration_controls);
INSERT INTO storage_metadata(key,value) VALUES('delivery_cursor',(SELECT CAST(COALESCE(MAX(delivery_order),0) AS TEXT) FROM outbox));
UPDATE storage_metadata SET value=CAST(MAX(CAST(value AS INTEGER),(SELECT COALESCE(MAX(delivery_order),0) FROM integration_controls)) AS TEXT) WHERE key='delivery_cursor';
CREATE TABLE body_snapshots (
 snapshot_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES profiles(owner_id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
 start_cursor INTEGER NOT NULL,
 watermark INTEGER NOT NULL,
 expected_count INTEGER NOT NULL,
 membership_sha256 TEXT NOT NULL,
 prune_resources TEXT NOT NULL CHECK(json_valid(prune_resources)),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','complete'))
) STRICT;
CREATE UNIQUE INDEX body_snapshots_open ON body_snapshots(connection_id) WHERE status='open';
CREATE TABLE body_snapshot_members (
 snapshot_id TEXT NOT NULL REFERENCES body_snapshots(snapshot_id) ON DELETE CASCADE,
 resource TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 PRIMARY KEY(snapshot_id,resource,entity_id)
) STRICT;
PRAGMA user_version=4;
`
export const INTEGRATION_SCHEMA_V5 = `
ALTER TABLE outbox ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0,1));
CREATE TABLE integration_media_transfers (
 request_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES profiles(owner_id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL REFERENCES outbox(event_id) ON DELETE CASCADE,
 metadata TEXT NOT NULL CHECK(json_valid(metadata)),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','terminal')),
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 last_error TEXT
) STRICT;
PRAGMA user_version=5;
`
export const INTEGRATION_SCHEMA_V6 = `
ALTER TABLE connections ADD COLUMN replaces_connection_id TEXT;
ALTER TABLE connections ADD COLUMN replacement_snapshot_id TEXT;
PRAGMA user_version=6;
`
export const INTEGRATION_SCHEMA_V7 = `
ALTER TABLE outbox ADD COLUMN delivered_at TEXT;
ALTER TABLE outbox ADD COLUMN updated_at TEXT;
ALTER TABLE integration_controls ADD COLUMN delivered_at TEXT;
ALTER TABLE integration_controls ADD COLUMN updated_at TEXT;
ALTER TABLE integration_controls ADD COLUMN last_error TEXT;
ALTER TABLE integration_media_transfers ADD COLUMN delivered_at TEXT;
ALTER TABLE integration_media_transfers ADD COLUMN updated_at TEXT;
PRAGMA user_version=7;
`
export const INTEGRATION_SCHEMA_V8 = `
ALTER TABLE connections ADD COLUMN capabilities TEXT CHECK(capabilities IS NULL OR json_valid(capabilities));
PRAGMA user_version=8;
`
export const INTEGRATION_SCHEMA_V9 = `
ALTER TABLE connections ADD COLUMN revocation_receipt INTEGER NOT NULL DEFAULT 0 CHECK(revocation_receipt IN (0,1));
PRAGMA user_version=9;
`
export const INTEGRATION_SCHEMA_V10 = `
CREATE TABLE integration_export_failures (
 owner_id TEXT NOT NULL REFERENCES profiles(owner_id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
 resource TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 error_code TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,connection_id,resource,entity_id)
) STRICT;
PRAGMA user_version=10;
`
export const INTEGRATION_SCHEMA_V11 = `
CREATE TABLE incoming_sources (
 owner_id TEXT PRIMARY KEY REFERENCES profiles(owner_id) ON DELETE CASCADE,
 connection_id TEXT NOT NULL REFERENCES connections(id),
 source_id TEXT NOT NULL,
 source_cursor INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO incoming_sources(owner_id,connection_id,source_id,source_cursor)
 SELECT owner_id,connection_id,source_id,source_cursor FROM body_sources;
ALTER TABLE body_sources DROP COLUMN source_cursor;
ALTER TABLE body_snapshots RENAME TO incoming_snapshots;
ALTER TABLE body_snapshot_members RENAME TO incoming_snapshot_members;
CREATE TABLE training_hints (
 owner_id TEXT NOT NULL REFERENCES profiles(owner_id) ON DELETE CASCADE,
 source_id TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 last_source_cursor INTEGER NOT NULL,
 PRIMARY KEY(owner_id,source_id,entity_id)
) STRICT;
CREATE TABLE training_hint_revisions (
 owner_id TEXT PRIMARY KEY REFERENCES profiles(owner_id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0
) STRICT;
PRAGMA user_version=11;
`
export const INTEGRATION_SCHEMA_V12 = `
ALTER TABLE incoming_sources RENAME TO incoming_sources_v11;
CREATE TABLE incoming_sources (
 owner_id TEXT NOT NULL REFERENCES profiles(owner_id) ON DELETE CASCADE,
 source_id TEXT NOT NULL,
 connection_id TEXT REFERENCES connections(id),
 source_cursor INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(owner_id,source_id)
) STRICT;
INSERT INTO incoming_sources(owner_id,source_id,connection_id,source_cursor)
 SELECT owner_id,source_id,connection_id,source_cursor FROM incoming_sources_v11;
DROP TABLE incoming_sources_v11;
CREATE UNIQUE INDEX incoming_sources_connected_owner ON incoming_sources(owner_id) WHERE connection_id IS NOT NULL;
PRAGMA user_version=12;
`
