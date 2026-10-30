# Eric openGym container releases

Develop on `opengym-custom-eric-flow`; preserve upstream `main`. After local
acceptance and merge, the first independent tag is **`v1.4.3-eric.1`**. Published
tags are immutable; increment the Eric number for fixes. This workflow does not
merge, tag, deploy or migrate services. Production deployment is out of scope.

## Setup

Enable Gitea Actions on the existing fork, with a runner labelled `ci` matching
SparkyFitness. It needs Docker daemon access, Node 22 action support, registry
connectivity and trusted registry TLS. Builds target the runner's native
architecture. Actions need checkout/setup-node and locked npm dependencies.

Configure **`REGISTRY_USER`** and **`REGISTRY_PASSWORD`** as repository secrets or
organization Actions secrets available to this repository, with registry push
permission for the intended namespace. Never put credential values in Git.

An authorized `v*-eric.*` tag push runs `.gitea/workflows/release-images.yml`.
Both package versions must match its base (`1.4.3` initially). Custom tags do not
claim upstream stable-release status; upstream `release-check.mjs` is not used.

## Artifacts

Only `192.168.200.101:54453/zhangzhicheng/opengym-api` and
`192.168.200.101:54453/zhangzhicheng/opengym-web` receive images. Both get the
exact version tag, `sha-<full commit SHA>` and `latest`, with shared
VERSION/VCS_REF/BUILD_DATE. Package versions remain unchanged; web gets
`APP_BUILD=<tag>`, for example `1.4.3+v1.4.3-eric.1`.

API uses context `./api`, target `default`; web uses root context and
`web/Dockerfile`. Coach is deliberately omitted because its optional SDK, CLI
and sandbox add download/build cost. No `-coach` tag is published.

Native API/frontend tests each cap workers at two to limit NAS memory use.
Generated-source checks, locales and the 180 px media
check must pass before builds. Neither test nor build failures are masked.
Both images build before login/push; version and SHA tags precede latest aliases.
Pushes are not atomic: inspect both repositories after partial failures and use
the exact accepted version, not `latest`, for deployments. Jobs are serialized,
but rerunning an older tag can still move `latest` backward.

## Source And Media

Keep every distributed tag's corresponding source, build files, LICENSE and
NOTICE.md available to recipients at
<https://gitea.blueloverest.site:44443/zhangzhicheng/eric-openGym>.
Include the exact tagged source offer/link wherever the fork is distributed or
served; labels alone do not replace source access. Dockerfiles support metadata
build arguments but no source-URL argument, so CLI labels point to this fork
without editing Dockerfiles. AGPL-3.0-or-later labels remain intact.

Gym visual media are separately licensed, not AGPL. Only unmodified, at-most-180 px
openGym catalogue media and their notice ship in web, under the non-commercial
fork conditions in `NOTICE.md` and `catalogue/media/NOTICE.md`. Never copy them
into SparkyFitness, expose an independent media service or ship larger app-only
assets. No GitHub workflow or official registry publication is added; GitHub
release choices remain pending.

## APK Publishing

GitHub access and the public build mirror are now confirmed. The approved
replacement install, signing and ARM64 workflow contract is
[Eric Android Releases](ERIC_APK_RELEASES.md). The initial deferred checklist
below is historical; workflow setup is tracked in
`docs/integrations/github-apk-plan.md`. Phone acceptance still requires the
completed APK and does not follow from service-image acceptance.

The owner confirmed on 2026-10-30: Gitea builds container images; GitHub will build
APKs after GitHub network access is restored. Do not move APK builds to Gitea or
create an external GitHub repository without approval. Keep these explicit todos:

- Restore GitHub access and confirm the openGym build-mirror repository.
- Add a fork-specific Android workflow; keep official upstream release checks from
  rejecting custom tags or requiring fork commits on upstream `main`.
- Configure a persistent private signing key and monotonically increasing Android
  version codes. Confirm whether installation replaces the official app or coexists
  before choosing application identity/signing and test-data migration steps.
- Make the custom updater use the approved fork distribution channel, not the
  hardcoded `DuarteSantos8/openGym` release endpoint. Private repositories cannot
  be queried anonymously from an installed app; never embed a GitHub access token.
- Preserve exercise-media licensing constraints in the selected APK variant.
- Build the exact accepted tag, verify checksum/signature, then run real phone
  install, offline training, reconnect, managed-body protection and sync acceptance.

These are deferred gates, not successful APK builds or phone acceptance.

Static validation only, using the existing root `js-yaml` dependency:

```sh
node --check scripts/ci/release-images.test.mjs
node --test scripts/ci/release-images.test.mjs
```
