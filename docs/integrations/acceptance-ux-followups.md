# openGym Acceptance UX Follow-Ups

Date: 2026-10-31.

Implements the openGym-only follow-ups approved in SparkyFitness's
`docs/superpowers/plans/2026-10-31-sparkygym-test-and-followups.md`.

- Home's Start new workout opens the native workout picker, including freestyle
  and templates, even after multiple completed sessions. It does not create a
  session until the native start flow is used. Existing active sessions and saved
  workout editors remain resumable rather than being overwritten.
- Rest / skip this day opens the existing native date editor. Rest is an explicit
  owner action; displaying guidance never creates a rest note or excuses reminders.
- A covering dated SF plan with an omitted/empty weekday means Rest day. No
  covering plan (including after deletion) means No training arrangement. The
  date sheet retains native routine names and explicit local rest overrides.
  Offline metadata filtering and owner/server cache isolation are unchanged.
- Active and paused connections show peer identity, state, delivery counts and
  management actions without the primary setup invitation row. Re-pair with new
  keys deliberately opens the existing invitation form. Setup, pending approval,
  revoked and expired states retain the import entry. No origins, authorization,
  history consent, transport, stored data or binding rules change.

No session-to-plan association is introduced. Workouts, routines, private notes,
reminders and LAN/history behavior remain native and independently owned.

Two additive source strings are translated in all 19 locale packs, including
explicit pt-BR overrides: Start new workout and No training arrangement.

SF now supplies all 18 built-in circumferences. The BODY read model explicitly
maps SF's existing left/right biceps keys to native upper-arm fields, and maps
forearms, wrists, thighs, calves and ankles to their native left/right fields.
Keep peer wire IDs unchanged. Apply these aliases only to built-in numeric
length measurements in cm; custom definitions and incompatible units must not
overwrite native fields. Regression: `api/test/sparkygym-body.test.js`.

Native rotation rest steps remain Rest, not No training arrangement. A manual
rest override keeps the original scheduled routine in the date-sheet header
with the changed marker and the Rest option selected. Only unarranged gaps use
the empty-plan wording; this does not change actual scheduling or reminders.

Regression coverage: `Home.startdoor.test.jsx`, `sheets.day-note.test.jsx`,
`SparkyGymConnection.test.jsx` and the existing cache tests in
`lib/training-hints.test.js`. Run `npm test`,
`node scripts/check-locales.mjs` and
`node scripts/check-source-strings.mjs --strict` from `frontend/`.

No release build, commit, tag or production deployment is part of this change.
Local desktop/mobile-width browser checks use the existing source-preview stack;
native APK installation remains a separate acceptance step. A full frontend run
covered 553 files; its five failed files were corrected or rechecked outside
the sandbox together with related regressions (149 tests passed). Script tests
need permission to spawn local child processes; do not bypass their assertions.
