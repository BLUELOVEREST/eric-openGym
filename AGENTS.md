# Eric openGym Fork Guide

Last updated: 2026-10-30.

Read `CLAUDE.md` for upstream architecture, commands, translations and media rules.
This guide supplements those rules for the SparkyFitness integration.

## Repositories and Development

- This repository is `/home/zhangzhicheng/workspace/own/eric-openGym`.
- `origin`: `https://gitea.blueloverest.site:44443/zhangzhicheng/eric-openGym.git`.
- `upstream`: `https://github.com/DuarteSantos8/openGym.git`; push URL is disabled.
- Imported `main` is the current upstream baseline. Integration work is isolated on
  `codex/sparkyfitness-integration`, worktree `/tmp/opengym-sparky-integration-20261029`.
  Do not assume unaccepted work has landed in main or that remote branches were pushed.
- Future official release merges use an isolated worktree based on accepted custom
  development history. Preserve upstream translations and custom integration behavior.
- The companion repository is `/home/zhangzhicheng/workspace/own/eric-sparkyfitness`.
  Changes in either repository require reviewing the shared *wire* contract, not
  importing application code across the differently licensed repositories.
- No assistant attribution in commits, trailers or release descriptions.

## Integration Boundary

- Native `week[weekday]` remains routine-ID assignments; combined routines and
  independent freestyle workouts use upstream behavior. SF owns dated weekly intent.
  `api/integrations/training-hints-model.js` validates bucket-based source metadata.
  SQLite `incoming_sources` owns one cursor across body and hint projections;
  `training_hints` is separate from body ownership, profile state and private notes.
  Read `docs/integrations/training-hints.md` for the API and offline cache.

- Documents: `docs/integrations/sparkygym-architecture.md`,
  `docs/integrations/sparkygym-contract-v1.md` and
  `docs/integrations/sparkygym-implementation-plan.md`.
- Wire foundation: `api/integrations/sparkygym-protocol.js`; focused tests:
  `node --test api/test/sparkygym-protocol.test.js` from the repository root.
- Protocol utilities do not register routes or enable synchronization.
- SparkyFitness owns body values, target weight and weekly training intent. openGym
  owns concrete exercise execution, actual results and personal media. E-class
  analytics are deferred.
- Use event-driven reliable delivery; no scheduled business-data polling.
- Native transactional kernel: `api/storage/integration-store.js`; focused tests:
  `node --test api/test/integration-store.test.js`. It uses node:sqlite (tested with
  Node 22.22.0; that runtime emits an experimental-feature warning).
- Business state and separate connection/stream/inbox/outbox tables share one SQLite
  transaction. No hidden JSON journal, file fallback or dual-writes.
- `api/storage/profile-migration.js` is the startup-only, verified-backup importer.
  `profiles.sqlite` is now the server's sole profile source. Server reads/writes,
  cache revisions, reminders, media reference scans, Coach and MCP all use SQL.
  Never add a runtime read of a retired `state-<uid>.json` file.
- `api/storage/profile-reader.js` supplies read-only SQL access; `file-sync.js`
  supplies strict directory durability barriers. Account deletion retains a disabled
  `deletePending` auth tombstone until SQL, credential, Coach and media cleanup succeed.
  Pending deletion is not reversible through enable/recovery commands. Startup retries it.
- Read `docs/SELF_HOSTING.md#6-backups` before backup, restore or first SQL upgrade.
  Stop the old API before migration and archive the complete stopped data directory.
  No image rollback against migrated data; restore the pre-upgrade directory separately.
- Native pairing/resource routes are mounted through `api/integrations/sparkygym.js`.
  Read `docs/integrations/opengym-backend.md` for the service lifecycle, native body
  read model, transactional capture and focused fixture tests. Pairing still requires
  explicit approval by both owners before domain delivery is authorized.
- Never expose keys or queue metadata in public state. Encrypted credentials are
  supplied by a future pairing service; the storage kernel is not authentication or
  encryption. All owner arguments come from a trusted authenticated service context.
- Do not transfer official exercise images/animations. Personal workout media are a
  separate domain, and their transport is not implemented by the wire foundation.
- Do not change existing test/production services, publish tags, or build APKs unless
  requested. Test stack is currently `/home/zhangzhicheng/workspace/own/eric-opengym-test`.
- Read-only body ownership is enforced by the native storage boundary and stale
  PUT /api/data checks; a UI-only disabled input is insufficient. Managed clients
  send `X-SparkyGym-Client-Version: 1` and omit `MANAGED_BODY_FIELDS`.
