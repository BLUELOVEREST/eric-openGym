# Native Storage and API Plan

Date: 2026-10-29. Supersedes the abandoned hidden-JSON-journal draft.

## Review Result

- Retain independently implemented event validation, durable receipts and HMAC
  signing. They do not call PUT /api/data or contain legacy fallbacks.
- Remove the unimplemented profile-journal tests and draft. Integration persistence
  is not a private field merged into a client-owned profile document.
- Use SQLite transactions for openGym business state and separate relational
  connection, stream, inbox and outbox tables. SparkyFitness keeps PostgreSQL.
- Existing JSON must be migrated explicitly once, with backup and validation. Never
  fall back to files, dual-write files, or serve a stale shadow copy after SQL failure.
- Dedicated integration endpoints validate per-resource payloads. The signed event
  endpoint is a dedicated transport with typed dispatch, not a whole-profile endpoint.
- A valid MAC is not pairing, authentication scope, replay handling or domain validation.

## Completed: Transactional Kernel

1. [x] Write failing real-file SQLite tests in `api/test/integration-store.test.js`.
2. [x] Implement `api/storage/integration-store.js` using Node's built-in node:sqlite,
   requiring a supported runtime rather than adding a JSON fallback.
3. [x] Test profile CAS, atomic profile/event commit, persistent monotonic revisions,
   restart, duplicates, altered replays, stale events, failed projections, scope/owner
   isolation, revocation, retry state, acknowledgement validation and callback lifetime.
4. [x] Use BEGIN IMMEDIATE, foreign keys, WAL and synchronous FULL. Keep all domain writes
   synchronous inside the transaction; perform HTTP only outside it.
5. [x] Test uncommitted/committed SIGKILL recovery and two-handle stale CAS using real files.
6. [x] Keep integration routes unregistered until API auth and resource handlers are
   ready. No synthetic pairing or default active credentials.

## Completed: Native Server Cutover

- [x] Import registered legacy profiles once with a SHA-256-verified private backup,
  preserve the auth registry and its existing recovery copy, and commit all profile
  rows plus the migration marker atomically. Reject unknown owners and malformed data.
- [x] Retire JSON sources only after commit. Resume interrupted retirement without
  reimporting or advancing revisions; changed source bytes stop startup.
- [x] Move normal API reads/writes, conditional writes, admin views and media reference
  scans to SQL. Preserve public `_rev`/`_wid` semantics separately from SQL revisions.
- [x] Replace file-mtime caches with bounded SQL-revision caches; test actual parsing,
  LRU/TTL eviction and cross-handle updates.
- [x] Move Coach and MCP to lazy read-only SQL readers. No SQL failure returns an empty
  profile or falls back to a legacy file. Keep authentication metadata in db.json.
- [x] Make account deletion a durable, irreversible auth tombstone before data cleanup.
  Keep the tombstone on SQL/credential/media failures and resume on startup. Exclude
  pending users from auth, recovery, reminders and available-admin counts.
- [x] Cancel Coach work and discard late results on permanent account deletion while
  preserving the normal consent-revocation daily-cap behavior. Remove user job logs.
- [x] Retry directory fsync even when a preceding cleanup already removed its target.
- [x] Include storage/integration modules in both API image targets, update backup and
  rollback instructions, and preserve the existing one-API Recreate deployment policy.

## Subsequent Batches

- Add proper owner-approved pairing, encrypted directional keys and scoped endpoints.
- Add body-definition/value/goal tables and dedicated resource APIs. Connected clients
  use these native APIs; old attempts to edit externally owned fields are rejected,
  not silently repaired. Reject clients that cannot honor the new ownership contract.
- Add durable sending, wake-up/retry, typed receiving and SSE cursor replay.
- Add normal PostgreSQL migrations, RLS/schema mirrors/docs and repositories on
  SparkyFitness, then bodyweight and target-weight end-to-end tests.

No existing deployed service or database has been modified. E analytics remain
deferred. Local source tests are not deployment acceptance: build/verify the API image,
back up the actual stopped data directory and rehearse migration before deployment.

## Verification

Observed missing-module failure, then storage tests passing. HTTP opt-in and extra
credential fields each failed before their respective fixes. Independent review found
three additional defects (mutable envelope metadata, rejected callback promises and
serialization hooks); new regressions reproduced all three before fixes. Follow-up
review reported no remaining actionable P1/P2 findings in the kernel scope.

Initial kernel command from `api/`:

```sh
node --test --test-reporter=spec test/integration-store.test.js test/sparkygym-protocol.test.js test/durable.test.js
```

Initial result: 45 tests passed (20 storage, 23 protocol, 2 existing durable tests).
Final frozen-source verification: **777 API tests passed**, zero failures or skips,
and **131 MCP tests passed**, including real API end-to-end writes. Native MCP graph
loading and both worktrees' diff checks also passed. Final API log:
`/tmp/opengym-api-native-final-pass-20261029.log`.
Auth-directory-sync fault injection failed before the final strict barrier fix and
passed afterwards. Independent review reported no remaining P1/P2 findings within
the agreed storage-cutover scope after the fixes.
Companion SparkyFitness protocol suite: 28 passed at the preceding checkpoint, with
no companion runtime changes in this batch. Image/deployment acceptance is pending.
Node 22.22.0 emits an experimental node:sqlite warning; deployment runtime/binding
acceptance is mandatory before enabling this storage. No runtime fallback is allowed.
