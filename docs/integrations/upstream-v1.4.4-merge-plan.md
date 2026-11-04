# Upstream v1.4.4 Upgrade

## Scope

Merge official v1.4.4 into the accepted custom mainline in an isolated worktree.
Do not commit, push, publish or deploy without a fresh explicit request.
Preserve SQLite profile storage, source-owned body fields, reliable event delivery,
daily training hints, independent workouts and official translations.

## Tasks

- [x] Fetch v1.4.4 and create `/tmp/opengym-merge-v1.4.4` on `codex/merge-upstream-v1.4.4`.
- [x] Resolve API, MCP and source-storage conflicts; adapt new webhooks/watch cleanup.
- [x] Resolve frontend conflicts, retain upstream strings and custom supplemental keys.
- [x] Audit new weigh-in, module and programme paths against source ownership rules.
- [x] Wire phone and watch artifacts to the existing persistent custom certificate;
  propagate Eric versions to both modules and verify their package/certificate.
- [x] Run API/frontend/MCP regressions and generated-source/localization audits.
- [x] Review the complete diff and prepare local acceptance without changing services.

## Decisions

SparkyFitness remains authoritative for body data and weekly intent. openGym owns
actual training and personal media. No reverse weekly-plan ownership or automatic
switch to upstream webhook transport. E-class analytics remain deferred.
Wear OS remains an optional companion requiring Google Play services, not a new
direct-server body source. Phone and watch must share the stable custom signing key.

## Verification Evidence

- Root release-image workflow contracts: 5 tests passed outside the sandbox;
  sandboxed shell syntax subprocesses stalled and were explicitly stopped.
- Catalogue generation check: 5,632 exercises up to date.
- Licensed media check: 13,108 files, all within 180 by 180 pixels.
- Generated Coach library and 8 prompts match their sources.
- API documentation regenerated from merged OpenAPI: 112 endpoints, 33 schemas.
- Locale shape check: 19 locales, 3,643 keys each.
- Strict UI string audit: 2,981 translated strings present.
- Review identified warm-up conversion metadata loss, widget raw-body reads and
  watch pairing codes surviving session revocation; fixes and regressions are
  required before acceptance. Full application and native release validation is
  not yet complete. No services, tags or published artifacts have been changed.
- Frontend owner reports build and focused regressions passed. Complete suite:
  7,900 passing tests and one timeout; the timeout and related voice-string cases
  passed on a focused 89-test rerun. Read-only post-fix review found no remaining
  frontend blockers. Health-module session gating and truthful Siri ownership
  rejection are also covered. This does not yet certify API/MCP or native builds.
- Resumed validation: 8 phone/watch release contract and metadata tests passed;
  MCP 6 files / 145 tests passed. All four remaining Git conflict entries resolved.
- Pending watch codes now bind the issuing session version; a focused regression
  rejects redemption after revocation. Source code loading and generated API/Coach
  audits passed. Full API run discovered a date-dependent programme week calculation:
  `cleanPlan` failed to forward the payload reference time. Fixed it and reran
  18 API Coach/watch tests and 186 frontend Coach tests, all passing.
- Full API run finished: 952 tests, 950 passed and 2 failed. The date issue above
  was one failure; the other test modified retired JSON after startup rather than
  the authoritative SQLite profile. Updated that fixture to commit through the
  native store. Both failed files plus watch authorization reran: 20/20 passed.
  This is full-run plus targeted post-fix evidence, not a wholly green full rerun.
- Final `git diff --check` passed and no unmerged index entries remain. The merge
  is intentionally uncommitted in its isolated branch; mainline and services are
  unchanged. Native Gradle compilation, real phone/watch pairing and local UI
  acceptance remain follow-up checks before publication/deployment.
