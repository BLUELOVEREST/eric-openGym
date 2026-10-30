# GitHub APK Release Plan

Approved 2026-10-30: keep the original application ID, replace the official app
after backup/uninstall once, then update custom builds with one persistent key.
GitHub mirror: BLUELOVEREST/eric-openGym. Gitea remains the source mainline.

## Design

Build only sideload Release ARM64 with the repository's licensed 180 px media.
Never upload private higher-resolution media, credentials or signing files.
Keep package version 1.4.3; use immutable Eric tags and native version codes
100000000 + the global Eric release number. New workflow code uses eric.2,
never rewrites eric.1. Both web metadata and native version carry the same tag.
Update checks use only the public fork release channel and compare Eric numbers.
Publish signed APK, SHA-256 and signing certificate information after verification.
Use an initially draft GitHub release so interrupted uploads cannot become latest.
No Gitea tag/image rebuild or production deployment in this task.

## Execution

- [x] Test custom release parsing, version ordering and fork update endpoint before implementation.
- [x] Add strict tag metadata helper, native version/ABI properties, and GitHub APK workflow.
- [x] Verify same-tag checkout, required secrets, fixed certificate, package/version/ABI and checksums before publication; guard upstream-only release/image jobs.
- [x] Generate one persistent signing identity outside Git and configure GitHub secrets without exposing values.
- [x] Run focused/full affected frontend tests, source/generated checks and workflow regression tests; review the diff.
- [x] Merge accepted changes, push source to Gitea and GitHub, push only the new GitHub tag and confirm Actions starts.

## Build Handoff

The accepted source commit is `9b201bf037e7c76f125dc1dec492e4e2318652bb`,
tagged `v1.4.3-eric.2` on GitHub only. Gitea received the development branch,
not the APK tag; accepted service images/deployments were left unchanged.
Frontend full regression passed 6,578 tests; default/custom APP_BUILD updater
checks passed 46 tests; workflow and artifact verification passed six tests.
Source strings, locales, generated catalogue and 180 px media checks passed.
Independent review found no P1/P2 issues in this scope.

The newly initialized GitHub mirror needed its default-branch workflow index
refreshed before manual dispatch. The default branch was restored to
`opengym-custom-eric-flow`, and the temporary same-commit branch was removed.
Initial build: <https://github.com/BLUELOVEREST/eric-openGym/actions/runs/41041998099>.
The task was triggered successfully; this handoff does not claim the APK has
finished compiling, been published or passed phone installation acceptance.

Hardware install, official-to-custom backup/restore and offline phone acceptance
require the completed APK and remain subsequent user acceptance, not CI claims.
