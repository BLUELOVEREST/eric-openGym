# SparkyGym Integration Implementation Plan

> Execute task-by-task with test-first changes and review checkpoints. No release or
> production deployment until end-to-end local acceptance. E-class analytics deferred.

**Goal:** Independent authoritative applications exchange body data, workouts, personal
media and SparkyFitness-owned daily training hints through reliable, non-polling events.

**Architecture:** Versioned HTTP events, scoped pairing, atomic outbox/inbox and
protected projections. PostgreSQL for SparkyFitness; native SQLite transactions for
openGym business state and separate integration tables. No shared application code,
hidden JSON journal, runtime file fallback or Redis service.

**Tech Stack:** TypeScript/Zod/Vitest and Node crypto on SparkyFitness; dependency-free
Node ESM/node:test on openGym. Existing frontend and native app frameworks retained.

## Milestone 1: Wire Protocol Foundation (current batch)

- [x] Write synthetic cross-repository protocol tests before implementations.
      SparkyFitness: `SparkyFitnessServer/tests/sparkyGymProtocol.test.ts`.
      openGym: `api/test/sparkygym-protocol.test.js`.
- [x] Confirm tests fail on missing implementations, not infrastructure problems.
- [x] Add `shared/src/schemas/api/SparkyGym.api.zod.ts` and root exports for the strict
      event envelope, ownership direction and durable receipt contracts.
- [x] Add `SparkyFitnessServer/integrations/opengym/protocol.ts` for request-byte
      signing and verification. openGym independently implements the same public wire
      contract in `api/integrations/sparkygym-protocol.js` without package dependencies.
- [x] Cover UTF-8 body bytes, body tampering, path binding, wrong key, key ID syntax,
      stale/future timestamps, exact skew boundary, missing/invalid headers, size bounds,
      invalid dates/revisions, wrong producer direction, delete semantics and unknown fields.
- [x] Run both focused test suites and a shared golden-vector parity check. Run
      shared/server validation and report any baseline errors; no route registered yet.

Commands:

```sh
cd /tmp/sparky-opengym-integration-20261029/SparkyFitnessServer
pnpm exec vitest run tests/sparkyGymProtocol.test.ts
pnpm run validate
cd ../shared
pnpm run validate
cd /tmp/opengym-sparky-integration-20261029/api
node --test test/sparkygym-protocol.test.js
```

Acceptance: same synthetic valid events and signatures accepted by both independently
implemented validators; malformed/unauthorized direction rejected. No business writes.

## Milestone 2: Pairing and Atomic Persistence

Storage checkpoint (2026-10-29): openGym server/MCP/Coach/media now use the native
SQLite source with one-time verified import, SQL revision caches and resumable account
cleanup. That historical checkpoint had 777 API tests and 131 MCP tests. Pairing,
encryption, resource handlers and the PostgreSQL boundary are now implemented;
current evidence and remaining gates are tracked in the progress document.

SparkyFitness files: new owner-only integration routes/service/repository, normal SQL
migration, RLS policies and matching shared database/API schemas. Update database
security tiers and family-sharing docs; leave db_schema_backup.sql to CI.
openGym files: native SQLite storage and dedicated connection/resource routes;
explicit one-time JSON migration, with no runtime file fallback.
Extend `api/Dockerfile` to include the integration modules when routes start importing
them; add a build-context regression so source-only success cannot hide missing files.

- [x] Test expiring one-use pairing, both-owner approval, no delegated binding,
      credential encryption, directional keys, rotation, revocation and private-LAN opt-in.
- [x] Test transaction rollback leaves neither business change nor queued event;
      successful commit leaves both. Use rollback and subprocess crash fault injection
      against the real SQLite store, including WAL recovery.
- [x] Test public GET/PUT state, exports, mobile backups and logs never expose secrets.
- [x] Add durable entity revisions and replay receipts, including conflicting IDs,
      stale events, concurrent phone updates and account deletion/reset behavior.
- [x] Start migration only on an isolated fixture DB; run RLS owner/delegate tests.

Acceptance: pairing creates a least-privilege identity binding; crash-safe queue and
receipts exist, but no domain synchronization is enabled by default.

## Milestone 3: First Vertical Slice - Body Weight and Target Weight

- [x] Define strict payload schemas for weight and target weight before routes.
- [x] Enqueue only from successful authoritative writes, including Health Connect and
      import paths; no duplicate queueing at both controller and repository levels.
- [x] Implement dedicated event receiver and protected openGym projections. Cover every
      writer (normal state PUT, imports, reset, AI, stale/offline clients), not just UI.
- [x] Wake SparkyFitness sender by post-commit notification; add one-shot retry timer,
      startup/listener reconnect recovery and explicit paused/error states. No cron scans.
- [x] Test kg/lb conversion, date versus measured time, repeated/delayed events,
      out-of-order corrections, clear/delete, restart and a failed destination.
- [x] Add owner connection UI, body source labels/read-only controls and sync status.
      Use existing i18n conventions in each app; include web/mobile contracts.

Acceptance: fixture scale write reaches openGym automatically; phone edits cannot
overwrite it; disconnected receiver catches up without polling or data loss.

## Milestone 4: Remaining Measurements and Client Notifications

- [x] Expand strict metric definitions with explicit units, semantic mapping and custom
      definition IDs; exclude weekly weight-rate goals. Confirm biceps/upper-arm protocol.
- [x] Add owner-authenticated SSE revision notifications with cursor replay/compaction
      handling, explicit snapshot recovery and native reconnect integration.
- [x] Test partial same-day updates preserve other metrics; historical snapshots remain
      historically meaningful. Test notification loss and browser reconnect. Physical-phone
      suspended-app acceptance remains deferred with APK publishing.

## Milestone 5: Training Results and Schedule Summary

- [x] Specify stable workout/exercise/set IDs and lossless nested set payloads.
- [x] Capture openGym business updates plus outbox in one SQL transaction, including
      imported/backdated edits and deletes. Do not enqueue active-workout timer ticks.
- [x] Add SparkyFitness openGym exercise source and snapshot projection; preserve raw
      topology when native sets cannot express it. Validate user-scoped custom IDs.
- [x] Preserve source lineage and explicitly suppress only duplicate openGym/Hevy
      indirect ingestion, retaining watch running/football, sleep and other health data.
- [x] Publish SF-owned dated weekly intent with timezone and native time buckets/main
      as OG daily hints; do not reflect unaccepted AI proposals or silently replan meals.
- [x] Verify diary, library, reports and mobile/web dependent cache invalidation.

## Milestone 6: Personal Media, History and Acceptance

- [x] Implement authenticated fixed-path media transport with limits, MIME and hash
      verification; no arbitrary URL fetch and no official catalogue assets.
- [x] Test per-owner archive dedupe, separate attachment/file deletion and retry after
      metadata accepted but bytes failed. Mark pending media visibly.
- [x] Add explicit initial snapshot import at a consistent watermark, retaining live
      deltas and source lineage. Keep all existing Hevy history; review ambiguous matches.
- [x] Verify both complete package validation/test workflows, mock-free test stack,
      browser offline/reconnect, authorized/private origins and restore/recovery behavior.
- [ ] Review actual diffs and credentials; merge accepted branches, then request
      coordinated Gitea image builds. GitHub/APK builds and phone acceptance are deferred;
      no production upgrade is authorized by this milestone.

## Deferred and Gates

- E-class analytics, non-strength sport scoring and algorithm snapshots are not in
  these implementation milestones. Their coverage requirement remains binding.
- Protocol foundation alone was not a working integration. Pairing and domain routes
  are now exercised in isolated real services; unchecked acceptance gates still apply.
- Resource schemas and pairing UX require their own executable task plans at their
  milestone start; do not silently infer measurement semantics or destructive policies.
- Approved openGym rules use an independent `v1.4.3-eric.1` sequence and Gitea image
  builds. Do not reuse SparkyFitness's global release number. GitHub networking and
  APK distribution remain explicit follow-up work.
