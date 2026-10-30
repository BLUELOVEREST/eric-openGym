# SparkyGym Completion Contract

**2026-10-30 approved correction:** SparkyFitness sends weekly training intent as
dated daily hints. openGym independently records concrete daily workouts and sends
actual results back. There is no plan-session association or meal-source picker.

Date: 2026-10-29. Implements the already approved architecture and ownership decisions.
No production deployment is authorized by implementation alone.

## Native Boundary

Owner management uses `/api/integrations/sparkygym` in both applications. Peer
transport uses `/api/integrations/v1`. Never call the peer's whole-profile PUT.
Every management operation uses the actual signed-in owner, not a delegated target
or a body-supplied user ID. Peer operations use only the paired identity binding.

### Owner Routes

- GET `/api/integrations/sparkygym`: public connection/status/capability records.
- POST `/api/integrations/sparkygym/invitations`: SparkyFitness creates a ten-minute
  invitation for an explicitly configured peer origin and selected resource scopes.
- POST `/api/integrations/sparkygym/claim`: openGym's authenticated owner imports it.
- POST `/api/integrations/sparkygym/:id/approve`: SparkyFitness's original owner
  approves the claimed peer identity. No automatic activation on claim alone.
- POST `/api/integrations/sparkygym/:id/pause`, `/resume`, `/revoke`: owner controls.
- POST `/api/integrations/sparkygym/:id/snapshot`: explicit initial/history sync.
- POST `/api/integrations/sparkygym/:id/rotate`: a new invitation replaces this
  connection only after another complete both-owner approval. Fresh root/directional
  keys and connection namespace, not an insecure in-place shared-key overwrite.
- POST `/api/integrations/sparkygym/:id/purge`: confirmed removal of this revoked
  source's projections only. Ordinary reset/unlink never purges them.

GET never returns invitation secrets, encrypted credentials or queue body contents.
Invitation secret is returned once at creation and redacted from logs. Approval and
explicit history import must identify the peer and show affected record counts.

### Peer Routes and Signing

- POST `/api/integrations/v1/pair/claim`: invitation-secret HMAC authenticates claim.
- POST `/api/integrations/v1/pair/accept`: directional-key HMAC authenticates approval.
- POST `/api/integrations/v1/events`: existing exact-byte event contract.
- GET `/api/integrations/v1/capabilities`: paired, authenticated capability discovery.
- POST `/api/integrations/v1/snapshot`: paired request for a source-owned snapshot.
- POST `/api/integrations/v1/media`: bounded binary frame; never an arbitrary URL.
- POST `/api/integrations/v1/revoke`: paired revocation notification.

Keep the existing event signing golden vector unchanged. Other request paths use
`sparkygym-control-v1\n<METHOD>\n<PATH>\n<REQUEST_ID>\n<TIMESTAMP>\n<KEY_ID>\n<SHA256>`;
allow only the fixed methods/paths above. All packets retain the same key/timestamp/
signature header names and clock-skew validation. Receipts are authenticated with
`sparkygym-response-v1\n<REQUEST_ID>\n<STATUS>\n<TIMESTAMP>\n<KEY_ID>\n<SHA256>`.
Request IDs identify the immutable operation/event, not application users.
Signed responses echo `X-SparkyGym-Request-Id`; the receiver verifies this header
matches its pending request before accepting the response signature or body.

Control request IDs are part of the authenticated canonical string. Changing the
header ID without signing again must fail, including snapshot requests. Media
requests additionally send `X-SparkyGym-Body-SHA256` for the complete frame: verify
its declared digest against the control MAC before buffering the large body, then
verify the actual frame digest before any archive or database mutation.

Revoked connections accept only the exact previously authenticated revocation
request ID and body hash. Keep its receipt-only directional keys sealed separately
from normal credentials so a lost ACK can be re-signed without re-enabling domain
access. A verified peer revocation also satisfies a concurrent local revocation.
The strict revocation JSON is `{ "version": 1, "connection_id": "<UUID>" }`;
its immutable request ID is carried in the authenticated header, not duplicated
in this body. Success uses the signed `{ "connection": <public status> }` shape.

Invitation offer is a strict object with `version:1`, `connection_id` UUID,
`sf_origin`, `sf_owner_ref`, `sf_nonce`, `secret`, `expires_at`, `peer_origin`,
`scopes`, `include_history`. Nonces/secrets are 32 random bytes encoded base64url.
Claim and acceptance bodies have `version:1`, `connection_id`, `sf_owner_ref`,
`og_owner_ref`, `sf_origin`, `og_origin`, `sf_nonce`, `og_nonce`, `scopes`,
`include_history`. The claimant server supplies its authenticated owner's reference.

Root key: HKDF-SHA256(invitation secret, SHA256(sf_nonce + '.' + og_nonce),
`sparkygym-pair-v1\n` plus connection_id, sf_owner_ref, og_owner_ref, sf_origin,
og_origin joined by newlines, 32 bytes). Directional secrets are HMAC-SHA256(root,
`sparkyfitness-to-opengym`) and HMAC-SHA256(root, `opengym-to-sparkyfitness`). Key IDs
are connection UUID plus `_sf` and `_og`. Never send these secrets to a peer over HTTP.
Encrypt local secrets using the application's existing persistent encryption root.

Claim is single-use but exact-byte retry is idempotent; a changed claim is 409.
Both owners must approve before domain events are accepted. Persist approval delivery
as a control job; retries after restart must finish activation without polling.
Rotation uses explicit re-pairing, atomic retirement and a confirmed snapshot; mappings
use source identity plus entity ID, not a connection ID that changes on rotation.
Keep unacknowledged old work until the replacement snapshot has durably superseded it.
History requests require the binding's explicit history consent. Re-pairing that
requests historical import must obtain that consent before retiring the old binding.

Outgoing requests pin validated DNS results, reject redirects, credentials, non-HTTP
schemes, unspecified/multicast/link-local/metadata destinations. HTTP and private
networks each require explicit per-connection opt-in, never a global exemption.
Use isolated private-IP fixture servers for real-network acceptance.

## Event Resources

Add `body_definition` to the existing source-owned body resource family. The other
resource names and event envelope remain unchanged. Strict payload schemas live in
SparkyFitness shared; openGym independently implements the same wire specification.
Do not copy application source across the repositories' different licenses.

- `body_definition`: metric_id, label, value_type (`mass`, `length`, `percent`,
  `number`, `text`), unit (`kg`, `cm`, `percent`, `none`, `text`), builtin, enabled.
- `body_measurement`: metric_id, date (real calendar YYYY-MM-DD), value (finite
  number or text according to type), unit, measured_at (UTC timestamp or null),
  timezone (IANA), definition (label/value_type/builtin). A value carries its own
  unit/definition snapshot so later definition edits cannot reinterpret history.
- `body_goal`: metric_id=`target_weight`, finite positive value, unit=`kg`,
  effective_date (calendar day or null). Weekly weight-rate goals are excluded.
- `exercise`: exercise_id, name, category, equipment, primary_muscles,
  secondary_muscles, aliases, notes. Arrays/strings have bounded lengths. No
  catalogue animation/image URLs or files. Personal exercise media are not assumed.
- `workout`: workout_id, name, date, timezone, started_at, ended_at,
  duration_seconds, calories_kcal, body_weight_kg, target_weight_kg, exercises,
  source_snapshot. Each exercise has instance_id, exercise_id, name, position,
  sets and source_snapshot. Sets have set_id, position, kind, completed, reps,
  weight_kg, duration_seconds, distance_meters, rpe, rir, load_mode,
  superset_group and topology. Nullable unavailable quantities stay null, not fake
  zeros. source_snapshot/topology are explicitly versioned finite JSON objects for
  lossless native fields, not a fallback source of calculated statistics.
- `schedule_summary` (SF producer): name, timezone, week_start (0=Sunday..6=Saturday), effective_from,
  effective_until, days. Each day has weekday and slots; each slot has
  time_slot, activity, is_main. There is no slot_id or invented clock value:
  time_slot is morning/noon/afternoon/evening, matching SF native focus data.
  Each nonempty day has exactly one main and up to four distinct time buckets.
  Rest days have no slots. Only active accepted weekly training-focus plans,
  including future SF date ranges; no AI drafts and no openGym schedule ownership.
- `personal_media`: media_id, sha256, bytes, mime, kind (`workout`, `progress`),
  workout_id (or null), date, caption. Only actual owner-uploaded personal files.

All normal body values use canonical kg/cm/percent/none. Built-in IDs preserve their
SparkyFitness column names; custom IDs use `custom:<category UUID>`. Do not alias
left/right biceps to upper-arm measurements. Add distinct source-defined fields where
openGym has no exact equivalent. Unknown/non-numeric custom quantities retain text;
never guess a unit conversion. Partial same-day events cannot erase other metrics.

## Persistence and Delivery

SparkyFitness creates owner-only connection, stream, outbox, inbox, external entity,
notification and media records via normal migrations plus RLS/Zod/docs. PostgreSQL
triggers capture committed authoritative measurement/definition/target-weight changes,
including import/Health Connect paths. They enqueue in the same transaction and use
NOTIFY as a wake-up only. Trigger-only privileged helpers cannot be called directly
by the app role to impersonate another owner. Peer key lookup is a narrowly scoped
encrypted-credential metadata lookup, not system-pool access to arbitrary user data.

Sources: check_in_measurements, custom_categories, custom_measurements,
onboarding_data.target_weight and active weekly training-focus templates/sessions.
Do not sync nutrition or exercise-goal fields. Plan changes are captured in the
same native transaction, publishing final valid data rather than intermediate
multi-row edits. Timezone/week-start changes refresh source metadata.
Finite numeric values only; unsupported values become explicit text definitions.

openGym detects accepted workout/exercise/media changes inside its native
profile transaction and enqueues complete source entities or tombstones there.
Persist intrinsic exercise-instance/set IDs; never use mutable array positions as
identity. Active-workout timer ticks do not emit events. Delivery workers scan due
work only on startup/reconnect/wake-up and use one-shot persisted retry deadlines.
No periodic business-data or peer-status polling. Invalid payloads are terminal,
auth failures pause, and transient errors retry with bounded jitter/Retry-After.
Explicit owner resume makes pending nonterminal deliveries immediately eligible
without erasing their attempt history or reviving terminal failures.

Apply receiver inbox, stream revision, normalized projection and notifications in
one transaction. Preserve raw workout topology when native diary sets cannot express
it, but also populate real diary/exercise/set records for ordinary reports. Imported
SparkyFitness records are source-owned/read-only across all edit/delete paths.

openGym body projections use native domain tables and `/api/body/profile`, not hidden
profile metadata. UI/Coach consume an explicit body read model. Paired ordinary PUT,
imports, reset, AI and stale clients cannot alter managed body fields. Updated clients
use `X-SparkyGym-Client-Version: 1`; stale writers are rejected rather than repaired.
Ordinary local reset and disconnection retain managed history; purge is separate.

Training hints use their own native SQL projection and owner-authenticated
`GET /api/training-hints?date=YYYY-MM-DD`, not `dayNotes` or editable profile JSON.
Response: `{revision,date,hints:[{entity_id,...schedule_payload}]}`. Hints support
future dates and do not change native routine assignments, rest excuses, reminders,
workout completion or meals. Current hint metadata is included even when historical
measurement import is not requested. Cache by server and owner; refresh from SSE,
focus/reconnect, never business polling. Actual workouts require only their own
stable IDs, not a reference to a hint or planned session.

## SSE, History and Media

Owner-authenticated GET `/api/integrations/sparkygym/notifications` is SSE with durable
cursor IDs and replay. A compacted cursor yields an explicit snapshot-required event.
Mobile reconnect/focus fetches the native snapshot; no promised suspended-app timers.

Snapshot captures source membership plus queued deltas at a consistent watermark.
Actual domain events require an authenticated positive safe-integer `source_cursor`
in the envelope. Base framing allows its absence only for the original protocol
fixtures; operational receivers require it. The source's global durable cursor never
resets during queue compaction. Delivery orders by cursor, not transaction-start time.
PostgreSQL body capture and snapshot creation share a per-owner transaction advisory
lock; snapshot source reads remain plain MVCC reads, never FOR UPDATE behind that lock.
SQLite uses its native immediate transaction. Begin/items/complete are prepared in
one transaction and become immutable only when committed. Begin declares cursor range,
record count and membership hash. Completion verifies receipt of that membership and
may remove absent same-source records only when their last cursor is at or before
the watermark, never later live deltas. A source cursor rewind is a visible paused
conflict requiring explicit recovery, not permission to overwrite newer peer history.
Begin/item/complete jobs are durable; finishing may tombstone missing records only
for that same approved source and snapshot, never existing Hevy/manual/watch data.
Retain historical Hevy records. Suppress indirect Health Connect copies only when
proven provider/external-ID lineage matches an already imported openGym session.
Ambiguous matches remain visible for review, never automatically delete them.

Media frame: 4-byte big-endian metadata length, UTF-8 JSON metadata, then file bytes.
Metadata has connection_id, request_id, media_id, sha256, bytes, mime. Hash the exact
whole frame for authentication. Enforce negotiated byte/MIME limits, verify magic and
hash before archive, use private temporary files, and atomically mark archive-ready
after durable file persistence. No base64 event bodies, third-party URL fetches or
licensed catalogue assets. Detach and file GC are different operations; retry pending
bytes independently from accepted metadata. Status is visible in both apps.
The signed media acknowledgement is
`{ "version": 1, "media_id": "<ID>", "sha256": "<64 lowercase hex>", "status": "ready" }`.

Explicit purge first commits projection/reference removal, then rechecks references
and removes unreferenced private files under an owner lock. It never removes another
owner's file or a file still referenced by another source. Directory durability is
confirmed even when retrying an already unlinked file. Failed cleanup is retryable;
ordinary revoke retains history and files.

## Reverse Proxy Requirements

Both applications require ordinary HTTP SSE forwarding, not WebSocket upgrades.
Preserve `X-Accel-Buffering: no` and disable buffering for the notification stream.
The SparkyFitness image provides a dedicated media route with a 101-MiB request-body
limit, request buffering disabled and 300-second send/read timeouts. An outer reverse
proxy must also allow these authenticated media requests; a smaller outer limit or
timeout wins. Apply settings only to the appropriate service/location, not globally.
Never expose the private archive as a static directory. These are deployment
requirements, not authorization to change the production proxy during development.

## Acceptance and Release Gates

Use fresh private-IP fixture services/users/DBs, never current test/production data.
Test owner/delegate isolation, expiry/replay, rotation/revocation, faults/restart,
kg/lb/date semantics, stale/offline writer rejection, direct workout updates/deletes,
schedule main slots, personal media and history membership. Run affected package
validation and tests. Preserve known official mobile translation audit failures.
Real phone installation, openGym release naming and publishing remain explicit user
acceptance gates, not synthetic passing checkboxes. No production deploy here.
