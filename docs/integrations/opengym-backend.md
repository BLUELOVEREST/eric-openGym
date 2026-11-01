# openGym Native Integration Backend

The API mounts owner management at `/api/integrations/sparkygym`, peer transport
at `/api/integrations/v1`, and the native body read model at `/api/body/profile`.
This does not authorize deployment or publishing.

## Service Interface

`api/integrations/sparkygym.js` exports `createSparkyGymIntegration(options)`.
Options bind the native store, persistent application secret, configured origin,
owner authentication and CSRF checks. Optional `transport`, `mediaFile` and
`onBodyChange` callbacks support isolated fixtures, private uploaded files and
local cache invalidation.

Every public connection includes `delivery` with native SQL counts for `pending`,
`failed` and `pending_media`, plus persisted `last_success_at` and sanitized
`last_error_code`. A healthy connection status does not hide queued or terminal work.

The returned service has:

- `handle(req, res)`: asynchronous; returns whether it handled the request.
- `beforeProfileWrite(ownerId, state, headers)`: synchronous write guard.
- `afterCommitWake()`: wakes durable delivery after a successful native commit.
- `start()`: drains committed work at startup and arms one-shot retry deadlines.
- `stop()`: aborts outgoing I/O, closes SSE clients and waits for delivery to stop.

There is no peer whole-profile PUT, runtime JSON fallback or polling interval.
Credentials use AES-256-GCM, a purpose-separated HKDF key derived from `DATA_DIR/secret`,
and connection-ID authenticated data. They never appear in public status or logs.

Verified incoming revocation retires normal credentials atomically. A sealed
receipt-scoped key record authorizes only the exact revoke path, immutable request
UUID and body SHA-256, allowing lost-ACK retries after restart. It cannot authenticate
capabilities, domain events or another revoke body. Simultaneous revocation records
peer-closure proof and satisfies a pending local revoke rather than retrying forever.

## Pairing and Body Ownership

The SF owner creates an invitation from `{self_origin,peer_origin}` backend URLs.
The openGym owner claims it with exactly `{invitation}`. All seven scopes and
`include_history:true` are mandatory authorization, not scope/history preferences.
Partial and legacy claims are rejected. `og_origin` binds to `invitation.peer_origin`,
not the configured public/browser `ORIGIN`. HTTP/private permissions are derived
server-side for this LAN transport. Both invitation destinations are validated;
DNS validation checks every result, and each outgoing request pins a validated
address and refuses redirects and prohibited metadata/link-local ranges.
This policy never bypasses owner CSRF or peer request/response HMAC checks.
Claim delivery is durable. No domain activity is authorized until a valid SF-owner
acceptance matches the complete locally persisted claim binding.

Activation, including same-source re-pairing, queues CURRENT initialization with
`include_history:false`: openGym exercises, no past workouts or personal media;
the SF side supplies current body/goal/definitions and dated hints. Full history
is queued only by an explicitly confirmed owner action or an authenticated peer
history request. The permanent scope/history/capability displays and network
switches are absent from settings; the confirmed history action remains.

Owner full queue requests check all pending snapshot controls (including delayed jobs)
and open incoming snapshots inside the same SQLite transaction as queue creation.
Owner requests return `409 snapshot_in_progress`, not a paused conflict. Incoming
authenticated peer requests instead coalesce onto a pending snapshot whose resource
coverage satisfies the request, including when begin is already delivered. A full
request never coalesces onto current-only work: its single full export is queued
behind that work using the existing delivery order. An open incoming snapshot does
not block the opposite-direction peer response. This avoids signed busy 409 errors
that existing senders treat as terminal. Exact authenticated request-ID retries
replay their durable receipt without generating another snapshot. A second
incoming begin is rejected while another snapshot is open; exact begin replay is
idempotent. No schema migration or process-local lock is required. After completion,
a later explicit full snapshot is allowed. Existing source/entity keys, revisions,
membership and media request/hash identities continue to make replay safe.

Activation archives local body fields in `native_body_archive` and removes those
fields from the synced profile in the same native transaction. The separate native
`body_sources` and `body_entities` tables retain source identity, revisions, canonical
units and historical definition snapshots. Every source sample keeps its entity ID.
Partial events never replace an entire day.

`GET /api/body/profile` returns exactly `managed`, `connection_id`, `source`,
`revision`, `definitions`, `measurements` and `target`. Measurement entries include
`entity_id` plus the complete body payload. `source` is `sparkyfitness` or null.

Clients writing a managed profile must send `X-SparkyGym-Client-Version: 1` and omit
`MANAGED_BODY_FIELDS`. Stale clients and attempts to send managed values are rejected,
including imports and resets. The native storage boundary independently enforces
this ownership. Revocation retains read-only history; only an explicit confirmed purge
of the currently revoked source removes its projections. Account deletion remains
an explicit deletion of all account-owned records.

`api/integrations/sparkygym-body-model.js` is a browser-safe pure module. Coach uses
its explicit composition with the native reader, not injected public profile metadata.
There is no biceps-to-upper-arm alias. Source-only metrics retain their own names.

## Capture, Delivery and Snapshots

Accepted native writes capture source entities and deletions in the profile transaction.
Unsupported native content is retained in the native profile and recorded in
`integration_export_failures` in that same transaction. It is visible in delivery
status, never replaced by a fabricated payload. Valid sibling entities still enqueue.
Full snapshots cannot publish partial membership when an included entity is blocked.
Completed workout exercise instances and sets receive persisted intrinsic IDs; array
positions are presentation only. Active-session ticks and unaccepted drafts are not
source entities. Workout sets retain canonical kg, load mode, nullable unavailable
quantities and versioned native topology snapshots.

Fixed-week slots use intrinsic weekday/routine IDs and a native routine time or
the saved reminder time. With neither, no schedule summary is emitted. The first
assigned routine is the main slot. Floating queues and AI drafts are excluded.

Event revisions are connection-scoped. `source_cursor` is a separate global durable
counter; queue compaction cannot reset it. A durable delivery order covers both
controls and events, preventing snapshot completion from overtaking its items.
One-shot timers use persisted retry deadlines. Restart, committed writes and resume
wake delivery. Response MACs are verified before receipt parsing or acknowledgement.
Unsigned infrastructure errors cannot terminally discard data.

Snapshot begin, source items and complete are captured under `BEGIN IMMEDIATE`.
Membership hashes use UTF-8 byte sorting and resource/NUL/entity/LF framing. Duplicate
and stale validated snapshot items still establish membership. Completion checks count
and hash before removing absent same-source entities at or below the watermark.
Post-watermark deltas and unrelated manual, Hevy and watch records are outside that
deletion boundary. Source rewind is a visible paused conflict.

Fresh same-owner re-pairing adopts the existing source namespace atomically and retires
the previous binding. Current initialization cannot retire its old pending work.
Old unacknowledged work remains until the replacement's explicitly requested full
snapshot has a verified completion acknowledgement. Different peer owners cannot
adopt existing history.

Personal uploaded workout media metadata and byte transfer have separate durable
records. Byte delivery waits for metadata acknowledgement, validates MIME magic,
size and SHA-256, and sends a four-byte metadata-length prefix followed by JSON and
file bytes. File lookup is restricted to the owner's native private upload store.
Pending transfers retain file references through normal media GC. No catalogue media,
third-party URL fetch or base64 event payload is used.

## Focused Checks

Use Node 22 and run focused files from the repository root, one worker at a time:

```sh
node --test --test-concurrency=1 api/test/sparkygym-*.test.js
node api/test/integration-store.test.js
node api/test/profile-reader.test.js
node api/test/openapi-routes.test.js
node scripts/build-api-docs.mjs --check
```

`sparkygym-network.test.js` uses fresh loopback fixture servers, independent explicit
LAN backend origins distinct from public ORIGIN and an in-memory database. It never opens current test or
production data. Full API/MCP validation, joint SF fixtures, phone acceptance and
release approval remain separate acceptance gates.
# Dated Training Hints

The SF-produced `schedule_summary` receiver uses the same incoming cursor ledger
as body resources and a separate native `training_hints` projection. Schedule-only
pairing does not manage body values. Owner-authenticated `GET /api/training-hints`
returns all current source payloads with `date:null`; an optional calendar date
filters only the inclusive effective range. See [Training Hints](training-hints.md)
for offline caches, rest-day semantics and the source-owned UI boundary.
