# SparkyGym Daily Hints Completion Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. The owner approved implementation and completion on 2026-10-30.

**Goal:** SparkyFitness coordinates health, weekly training intent and meals; openGym displays dated training hints and independently records actual training.

**Architecture:** Keep the reliable native transport, body projections, actual workouts and personal media. Replace the unpublished reverse schedule flow with SF-produced `schedule_summary` metadata. Do not rewrite openGym's native weekly assignment model: its existing freestyle workflow already supports multiple completed workouts per day. Hints never become rest excuses, routine assignments, completion checks or workout associations.

**Wire Contract:** `schedule_summary` is produced only by `sparkyfitness`. Entity ID is the source template ID encoded as a string. Payload is exactly `{name, timezone, week_start, effective_from, effective_until, days}`. Dates are calendar strings; end may be null. Each day is `{weekday, slots}`; weekday is 0=Sunday through 6=Saturday. Each slot is `{time_slot, activity, is_main}`; `time_slot` is `morning|noon|afternoon|evening`, matching native SF data without invented clock times. At most seven unique days and four unique time slots per day; nonempty training days have exactly one main. Rest days have no slots. No slot IDs and no training-result link.

**Source Policy:** Publish active native `training_focus` weekly templates, preserving their own date ranges, main and focus values. Inactivation/deletion removes the hint. Source writes and outbox capture commit atomically; snapshot includes current hint metadata even when historical measurements are not requested. Changing a user's timezone/week start refreshes metadata. No meal mutation and no OG-origin schedule write to SF.

**Receiver Policy:** Persist source-owned hints in native SQLite, separate from editable profile state and personal day notes. Use one incoming SF source-cursor boundary across body and hint resources. Support schedule-only scope, re-pair, snapshots, revoke retention and explicit purge. Owner-authenticated `GET /api/training-hints?date=YYYY-MM-DD` returns the applicable hints. Show them on Home and the date view, including future dates, without requiring templates or suppressing reminders. Cache per server/owner for offline viewing and refresh from committed SSE/focus/reconnect, never polling.

## Tasks

- [x] Restore openGym's original weekly-template model by removing only the superseded custom occurrence rewrite; preserve body/results/media integration and all unrelated edits. Remove `weekSessionId` business association. Verify original freestyle can record multiple workouts on one day.
- [x] Add failing shared/SF tests for new producer, strict bucket-based payload, rejection of OG producer/old clock shape, and immutable event signing parity; implement contract changes and remove reverse-direction SF schedule projection/UI.
- [x] Add SF native transactional capture, source snapshot and date/timezone tests. Verify no changes to meals, nutrition targets, local training intent or actual results.
- [x] Add OG native hint projection/API, snapshot membership and shared incoming cursor handling with rollback, stale/replay, scope isolation and explicit purge tests.
- [x] Add note-style Home/date presentation and per-owner offline cache; verify future date, morning/evening/main/rest, same-day multiple actual workouts and preservation of private notes/reminders.
- [x] Complete the independent account-archive cleanup migration/RLS/real-PG acceptance. Never edit `db_schema_backup.sql`.
- [x] Run package validation, full API/frontend/MCP/mobile regression and real isolated two-service/browser tests. Report accepted upstream translation errors separately; fix actual regressions rather than hiding them.
- [ ] Review final source/credentials, merge accepted work into custom development mainlines, and push immutable coordinated Gitea image tags. GitHub/APK and physical-phone tests remain explicitly deferred. Do not deploy production.

## Acceptance Examples

- A Sunday save of next week's chest/football split appears on the corresponding future OG date with no routine created.
- Native `dayNotes` values remain unchanged and `excusedOn` stays false for a training hint.
- Two freestyle workouts on the same day produce two independent SF workout records. Neither contains or requires a plan-session reference.
- Updating/removing the SF intent changes/removes the OG hint without editing actual workouts or food quantities.
- A failed delivery/restart catches up exactly once; independent owners cannot read each other's hints or archives.
