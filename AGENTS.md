# Eric openGym Fork Guide

Last updated: 2026-10-29.

Read `CLAUDE.md` for upstream architecture, commands, translations and media rules.
This guide supplements those rules for the SparkyFitness integration.

## Repositories and Development

- This repository is `/home/zhangzhicheng/workspace/own/eric-openGym`.
- `origin`: `https://gitea.blueloverest.site:44443/zhangzhicheng/eric-openGym.git`.
- `upstream`: `https://github.com/DuarteSantos8/openGym.git`; push URL is disabled.
- Imported `main` is the current upstream baseline. Integration work is isolated on
  `codex/sparkyfitness-integration`, worktree `/tmp/opengym-sparky-integration-20261029`.
  Do not assume unaccepted work has landed in main or that remote branches were pushed.
- Future official release merges use an isolated worktree based on accepted custom
  development history. Preserve upstream translations and custom integration behavior.
- The companion repository is `/home/zhangzhicheng/workspace/own/eric-sparkyfitness`.
  Changes in either repository require reviewing the shared *wire* contract, not
  importing application code across the differently licensed repositories.
- No assistant attribution in commits, trailers or release descriptions.

## Integration Boundary

- Documents: `docs/integrations/sparkygym-architecture.md`,
  `docs/integrations/sparkygym-contract-v1.md` and
  `docs/integrations/sparkygym-implementation-plan.md`.
- Wire foundation: `api/integrations/sparkygym-protocol.js`; focused tests:
  `node --test api/test/sparkygym-protocol.test.js` from the repository root.
- Protocol utilities do not register routes or enable synchronization.
- SparkyFitness owns body values and target weight. openGym owns training plans,
  workout results and personal media. E-class analytics are deferred.
- Use event-driven reliable delivery; no scheduled business-data polling.
- JSON business writes, private integration state and pending events need a single
  atomic boundary. Never expose keys or private queue metadata in public state.
- Do not transfer official exercise images/animations. Personal workout media are a
  separate domain, and their transport is not implemented by the wire foundation.
- Do not change existing test/production services, publish tags, or build APKs unless
  requested. Test stack is currently `/home/zhangzhicheng/workspace/own/eric-opengym-test`.
- Read-only body ownership must eventually be enforced by every server writer,
  including stale PUT /api/data requests; a UI-only disabled input is insufficient.
