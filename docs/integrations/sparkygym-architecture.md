# SparkyGym Integration Architecture

Date: 2026-10-29 (Asia/Shanghai).
Status: development design; no production endpoints or synchronization enabled.
Decisions: `2026-10-29-opengym-integration-decisions.md`.

## Repositories and Baselines

- SparkyFitness: development mainline `sparky-custom-eric-flow`, accepted release
  `v1.9.0-eric.59`, base `83b393a68`.
- openGym: `/home/zhangzhicheng/workspace/own/eric-openGym`, Gitea `origin`, official
  `upstream` at `https://github.com/DuarteSantos8/openGym.git`, upstream push disabled.
  Base `b6cfe2bbd` (v1.4.3 plus a README change). Keep `main` as the imported baseline;
  integration development uses `codex/sparkyfitness-integration` until acceptance.
- Isolated implementation worktrees: `/tmp/sparky-opengym-integration-20261029`
  and `/tmp/opengym-sparky-integration-20261029`. Do not remove while work is active.
- Future upstream upgrades use a selected release tag on an isolated branch based
  on the accepted custom mainline; no blanket ours-resolution of upstream changes.
- Do not transfer application source between differently licensed projects.
  Exchange an independently implemented HTTP protocol and synthetic test vectors.
  Gymvisual catalogue media never crosses this integration.

## Ownership

SparkyFitness owns body measurements, custom measurement definitions and target
weight. openGym holds read-only projections. Weekly weight-rate targets are excluded.
openGym owns exercise identities, routines, fixed-week schedules and training
results. SparkyFitness holds training snapshots and a minimal read-only nutrition
schedule. AI suggestions do not change the other system before user acceptance.
Personal workout media and day progress photos originate in openGym and are archived
in SparkyFitness. Equipment inventories, membership cards, AI transcripts, credentials,
UI settings and active workout drafts do not cross the boundary.

E-class analytics are deferred. Their eventual scope includes watch-recorded running
and football; do not disable their existing Health Connect ingestion. Only records
that already arrived directly from openGym are excluded from that indirect path.

## Reliable Delivery

1. An accepted business transaction allocates a monotonically increasing revision
   per connection/resource/entity and records a complete entity event or tombstone.
2. The event is durably stored in the same atomic boundary as the business write.
3. A post-commit notification wakes the sender. No periodic change detection.
4. Sender signs exact UTF-8 bytes, sends with a timeout, and awaits a durable receipt.
5. Receiver checks connection, role, signature, size, schema and negotiated capability.
6. Inbox receipt, record revision and business projection commit together. Responses
   are acknowledged only after persistence. Duplicate delivery is safe, not exactly-once
   transport. Same event ID with different body bytes is a protocol conflict.
7. Retry network failures, 408, 429 and 5xx with bounded exponential backoff and jitter;
   honor bounded Retry-After. Authentication failures pause the connection. Invalid
   payloads are visible terminal failures. Older entity revisions are acknowledged
   as stale and never overwrite newer data. A newer corrective event can proceed
   after an invalid older event; it must be a complete entity replacement.
8. Persist attempts and next due time. PostgreSQL LISTEN/NOTIFY wakes the SparkyFitness
   sender; a one-shot timer wakes retries. Recover pending work on startup and after
   listener reconnect. PostgreSQL notifications alone are not a durable queue.

### Persistence Boundaries

SparkyFitness adds owner-only connections, outbox, inbox and external-entity mappings
through normal migrations, shared Zod database schemas, RLS and security-tier docs.
Never use the existing production database for development migration tests.

openGym retains JSON storage. Store private integration metadata, entity revision
markers, inbox and outbox alongside business state in one atomically replaced profile
document. All writers for that profile share the existing serialized write boundary.
Never store secrets in the public state returned by GET /api/data or phone backups.
Account deletion, administrative restore and reset must use the same integration
boundary; a second JSON file written after the profile is not an atomic outbox.
Evaluate retained inbox/outbox compaction with unacknowledged items never discarded.

### Projection Protection

External ownership is enforced during *every* openGym writer, including normal PUT
/api/data, imports, reset, AI changes and stale offline clients. Clients hide edits
for managed body values and label the source; server checks remain authoritative.
Managed values survive ordinary local reset. Connection unlinking stops synchronization
without silently deleting history; explicit purge is a separate confirmed operation.

## Connection and Security

Owners explicitly approve both identities using an expiring single-use pairing code.
Do not accept an arbitrary user ID in an event as authorization. A connection binds
local/remote users, roles, allowed resources and configured origin. Delegates cannot
create or change that binding. Pairing transport must use HTTPS, except explicit
local-development HTTP opt-in; never enable that exception globally.

Use independent 32-byte directional signing secrets and revocable key IDs. Encrypt
credentials at rest and redact logs. Initial pairing, rotation and revocation require
owner sessions; never repurpose or copy ordinary login cookies, AI keys or Health
Connect permissions. The pairing implementation is a separate security-reviewed
milestone, not an unauthenticated key exchange.

Outgoing destinations are owner-configured allowlisted origins. Reuse the existing
outbound security controls, block redirects and reject SSRF targets except explicitly
approved private LAN destinations. Never trust a callback URL or media URL supplied
inside an incoming event. Media downloads use fixed peer paths, authorization,
streaming byte limits, MIME inspection and hash verification.

## Domain Delivery

- Measurements: one entity per user/day/metric; sparse updates do not clear unrelated
  fields. Calendar date, UTC measured time and IANA zone are distinct. Canonical units
  are kg/cm/percent/none, with explicit conversion to each app's storage convention.
  Do not map biceps to upper arm without an approved measurement definition.
- Workouts: source session and set IDs are stable; preserve set topology, units,
  bodyweight/assistance and single-bell semantics. Store lossless provider snapshots
  when native fields cannot represent data. Source revisions drive changes/deletes.
  Both existing exercise stats and diary cache families must be invalidated.
- Schedule: fixed-week summary with explicit timezone, weekday convention, effective
  dates, slot and main marker. Template edits do not automatically change nutrition.
- Media: event references owner-authorized content hashes, not arbitrary URLs. Upload
  bytes separately, acknowledge archive readiness separately, dedupe by owner/hash.
  Remove associations independently from file garbage collection. No catalogue media.
- History: one explicitly initiated snapshot at a consistent source watermark followed
  by queued deltas. No scheduled scans. Existing Hevy records are retained; ambiguous
  historical matches require review, never automatic deletion.

## Client Notifications

Authenticated SSE signals committed projection revisions while clients are open.
Reconnects resume through a durable cursor; if compacted, request an explicit snapshot.
Offline mobile clients synchronize on reconnect. Do not promise background execution
when a phone OS suspends the app. SSE is not the source of delivery durability.

## Deployment and Acceptance

No production deploy, tag or APK build is part of initial implementation. Use separate
fixture users and test data, never the two existing live/test deployments by default.
Verify crashes around each atomic boundary, retries, duplicate/altered replays,
out-of-order revisions, concurrent phone edits, clock skew, units, dates, revocation,
backup restore, scope isolation and source-loop prevention before enabling sync.
