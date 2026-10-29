# SparkyGym Event Contract v1

Status: proposed interface contract. Phase 1 implements validation and signing only;
none of the routes below are registered yet. These are not existing working endpoints.

## Transport

Both applications receive `POST /api/integrations/v1/events`. Capability discovery is
`GET /api/integrations/v1/capabilities`; it reports enabled resources after paired
authentication, not a public enumeration of user state. No implicit whole-state PUT.
JSON request bytes are UTF-8, at most 1,048,576 bytes, with Content-Type application/json.
Media bytes are never embedded in an event. Batch transport is outside v1.

```json
{
  "version": 1,
  "event_id": "11111111-1111-4111-8111-111111111111",
  "connection_id": "22222222-2222-4222-8222-222222222222",
  "producer": "sparkyfitness",
  "resource": "body_measurement",
  "entity_id": "measurement-opaque-source-id",
  "revision": 1,
  "operation": "upsert",
  "occurred_at": "2026-10-29T06:00:00.000Z",
  "payload": {
    "date": "2026-10-29",
    "metric": "weight",
    "value": 75.2,
    "unit": "kg",
    "measured_at": "2026-10-29T05:59:00.000Z",
    "timezone": "Asia/Shanghai"
  }
}
```

The envelope is strict: unknown envelope properties are rejected. Entity IDs are
opaque 1-200 character strings with no control characters; do not concatenate them
into file paths. UUIDs identify connections/events, not application users. Revision
is a positive JavaScript-safe integer allocated by the authoritative producer, never
derived from device time. occurred_at is canonical UTC with millisecond precision.
Delete uses payload null and a new revision; absence of a field is not a delete.
Upsert payload must be a finite, valid JSON object. Payload field schemas are validated
by negotiated resource handlers before any receipt is accepted; envelope acceptance
alone never implies domain acceptance. Unknown capabilities fail explicitly.

| Producer | Allowed resources | Authority |
| --- | --- | --- |
| sparkyfitness | body_measurement, body_goal | Body data only |
| opengym | exercise, workout, schedule_summary, personal_media | Training and personal media only |

E-class statistical resources are intentionally absent until their separate design.
Body-goal payloads support target weight, not weekly weight-rate goals. No user IDs,
credentials, AI transcripts, equipment inventories or membership codes in envelopes.
Origin/provider metadata in a workout identifies the original source and external ID;
it must be retained to avoid Health Connect loops. Revisions are scoped to the bound
connection/resource/entity triple. Changing value identity requires a tombstone and a
new entity, not silently reusing another metric's ID.

## Request Authentication

Required headers: `X-SparkyGym-Key-Id`, `X-SparkyGym-Timestamp`,
`X-SparkyGym-Signature`. Key IDs contain 1-64 ASCII letters/digits/underscore/hyphen.
Timestamp is a decimal epoch-second integer. Signature is `v1=` plus lowercase
HMAC-SHA256 hex, using a random 32-byte directional key. Canonical signing input:

```text
sparkygym-v1\nPOST\n/api/integrations/v1/events\n<timestamp>\n<key_id>\n<sha256_hex_of_exact_body_bytes>
```

No trailing newline. Receivers retain raw bytes and verify before JSON parsing.
Accept clock skew at most 300 seconds in either direction. Re-sign each retry with
a fresh timestamp while keeping event ID and exact body bytes unchanged. Compare
MACs in constant time. Key lookup is scoped to a paired, active connection and
direction; signature validity is not authorization. Public error responses do not
reveal whether a key, connection or remote user exists. A paused/revoked connection
must reject new deliveries even when the signature is valid.

## Durable Receipts and Errors

Successful durable processing returns HTTP 200:

```json
{"version":1,"event_id":"11111111-1111-4111-8111-111111111111","status":"applied","revision":1}
```

`status` is applied, duplicate or stale. `revision` is the receiver's current applied
entity revision, not necessarily the incoming older revision. A prior event ID with a
different raw body hash returns 409 event_conflict, never a duplicate receipt.
Concurrent equal entity revisions with different event contents are also conflicts.
No 202 success acknowledgement before durable business persistence.

Error shape: `{"error":{"code":"invalid_event","retryable":false}}`.

| HTTP | Code | Sender action |
| --- | --- | --- |
| 400 | invalid_event | Visible terminal failure; correct payload |
| 401 | authentication_failed | Pause connection and request repair |
| 403 | scope_denied | Stop delivery; owner reviews negotiated scope |
| 409 | event_conflict | Visible terminal conflict; never blind retry |
| 413 | payload_too_large | Terminal; media belongs on separate transport |
| 415 | unsupported_media_type | Terminal framing error |
| 422 | invalid_payload, unsupported_resource | Terminal domain/capability error |
| 429 | rate_limited | Retry using bounded Retry-After and backoff |
| 500/503 | receiver_unavailable | Retry with backoff |

GET capabilities, pairing, media paths and resource payload schemas are subordinate
milestones in the implementation plan; no consumer may assume arbitrary payloads are
supported because their resource name is reserved in this envelope.
