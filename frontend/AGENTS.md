# Frontend Integration Guide

Last updated: 2026-10-31.

Follow the root `AGENTS.md`, `CLAUDE.md`, and
`docs/integrations/completion-contract.md`. Keep the existing settings UI.

## SparkyFitness Boundary

- Native week assignments remain routine IDs. `src/components/TrainingHints.jsx`
  displays source-owned SF guidance on Home and date sheets. It never edits private
  notes, marks completion, associates workouts or requires a predefined routine.
  Training guidance without a local routine uses the existing freestyle start.
  Home keeps an explicit Start new workout entry into the native workout picker
  after completed sessions; an active session/editor must be resumed, not replaced.
  Rest / skip opens the existing day editor and never creates a private rest note
  automatically. A covering dated hint with no weekday slots means planned rest;
  no covering hint means No training arrangement, not rest. Native routines and
  explicit rest overrides retain their own meaning. Hint display never excuses a
  day or changes reminders. Connected/paused settings emphasize the existing
  summary and controls; importing replacement keys requires the deliberate re-pair
  entry and the existing invitation approval flow.

- `src/lib/sparkygym-client.js` owns the authenticated body cache and notification
  lifecycle. Cache keys include the server base and authenticated owner. Native
  persistence uses `opengym-external-body.json`, separate from the profile mirror.
  Hints use a separate `opengym-training-hints.json` cache with the same owner/server
  isolation. Fetch all metadata once with omitted date; resolve future dates locally.
  Never replace the full metadata cache with a date-filtered response.
- `src/store/useBodyState.js` supplies body-aware UI state. Imperative consumers
  use `readBodyState`. Neither writes the composed body view into `S`.
- `api/integrations/sparkygym-body-model.js` is the shared, browser-safe native
  domain helper. `web/Dockerfile` copies only that file alongside the Coach core.
  Never import application source from the differently licensed companion repo.
- Unknown body ownership on an authenticated account is read-only. A transport
  failure retains cached managed ownership, never writable local fallback. Only
  an authoritative `managed:false` response enables local body editing.
- Profile mutations, backup imports, reset, Health and AI must not change managed
  body values. Ordinary PUTs omit managed fields and send
  `X-SparkyGym-Client-Version: 1`. Do not add a profile PUT bridge or hidden source
  metadata. Backup/export code must never serialize connection credentials.
- SSE uses authenticated fetch streaming (including paired-phone bearer headers),
  not cookie-only EventSource. Advance durable cursors only after snapshot refresh;
  compacted cursors require explicit snapshot recovery. Reconnect/focus resumes
  reads; there is no business-data polling or suspended-phone timer guarantee.
- SparkyFitness creates fixed seven-resource invitations with history authorization.
  openGym imports only `{invitation}`; LAN backend origins are independent of public
  browser URLs. No scope/network switches or permanent authorization/capability
  displays. Activation initializes current data only; full history requires the
  confirmed history action. Purge requires a revoked source and confirmation.
- Preserve intrinsic `instance_id` and `set_id` values through edits and reordering.
  New sessions receive client IDs. The server canonicalizes legacy stored history;
  do not migrate it on unrelated preference edits. Workout body-weight and target
  snapshots stay with the workout, not the current body read model.
- Do not access or alter licensed catalogue media for this integration.

## Checks

Fork Android releases retain the original application ID. `-PericReleaseTag=vX.Y.Z-eric.N` opts into the custom native version and ARM64-only Release ABI; default upstream builds remain unchanged. `src/lib/release-version.js` compares upstream bases and numeric Eric counters, including Vite APP_BUILD metadata. `src/lib/update.js` uses only BLUELOVEREST/eric-openGym. Follow `../docs/ERIC_APK_RELEASES.md`; never embed a GitHub token or rotate the persistent signing identity as part of a build.

Run `npm test`, `node scripts/check-locales.mjs`, and
`node scripts/check-source-strings.mjs --strict` from `frontend/`. Every new string
must be translated additively in all locale packs, including pt-BR overrides.
Do not build native releases, deploy, commit, or push without explicit approval.
