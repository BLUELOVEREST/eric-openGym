# Eric Android Releases

The source mainline is Gitea `opengym-custom-eric-flow`. The public GitHub build
mirror is <https://github.com/BLUELOVEREST/eric-openGym>. Official upstream stays
separate. Gitea builds containers; GitHub builds APKs, never production services.

## Installing

The custom app retains `ch.duartesantos.opengym`; it does not coexist with the
official app. **The official signing key is not ours.** Before the first switch,
export a backup from the official app and confirm server sync where applicable.
Uninstall the official app, install the custom APK, then restore/pair as needed.
Uninstalling clears app-local storage; no automatic local migration is promised.
Later custom versions use the same signing identity and can update in place.

## Build Contract

`.github/workflows/eric-apk.yml` builds immutable `vX.Y.Z-eric.N` tags in this
GitHub repository only, or an existing tag selected by workflow_dispatch.
The checkout must be that tag's commit and its base must match frontend/package.json.
Native versionName is `X.Y.Z-eric.N`; versionCode is `100000000 + N` (N is the
independent openGym global counter). Increment N across upstream upgrades, never
reuse a published tag or regenerate the signing key to fix a build failure.

Only `assembleSideloadRelease`, ARM64, Standard 180 px repository media is built.
Plus/HD private media and Play packs never enter CI. LICENSE and media NOTICE stay
in the corresponding source and staged app assets. This is a personal/custom
release, not an official or store build. Existing upstream build scripts remain
available for their documented release-machine use; they do not run in this CI.

The updater uses this public fork's releases/latest. Numeric Eric suffixes are
ordered correctly, including APP_BUILD metadata from Vite. No GitHub credential
is embedded in the application. Upstream-only Docker publication and official
main-ancestry release checks are guarded, not run for custom releases.

## Signing And Recovery

These GitHub Actions Secrets are required:

- `ANDROID_KEYSTORE_BASE64`: persistent PKCS12 file, base64 encoded.
- `ANDROID_STORE_PASSWORD` and `ANDROID_KEY_PASSWORD`.
- `ANDROID_KEY_ALIAS`.
- `ANDROID_CERT_SHA256`: SHA-256 of the DER signing certificate, 64 hex digits.

The local private backup lives outside Git at
`~/.config/eric-openGym/signing/`: release.p12, credentials.json and certificate.der.
Keep a separate encrypted/offline copy of this directory. Never upload it as an
Actions artifact, put it in an issue/chat, commit it, or replace it with a fresh
key on every run. Losing the key prevents future in-place updates.

The runner decrypts the signing file only during the signing step and removes it
on exit. Passwords are environment references, not command-line values. APK
verification checks signature, fixed certificate, package ID, versionName,
versionCode, ARM64-only native code and absence of the debuggable flag.
Alignment uses SDK Build Tools' `zipalign -P 16` before signing and verifies the
signed archive without modifying it, following the
[Android tooling reference](https://developer.android.com/tools/zipalign).

## Output And Publication

An Actions artifact contains `openGym-X.Y.Z-eric.N-arm64.apk`, its `.apk.sha256`,
SHA256SUMS and public signing-certificate.txt. Successful builds create a draft
release, upload verified assets, then publish it as latest. Published releases
are never overwritten. If an upload interrupts a draft, inspect/remove its
incomplete assets before retrying; the workflow refuses conflicting asset names
rather than silently replacing them. A failed build is not a completed release.

The initial workflow release is v1.4.3-eric.2 because eric.1 was already published
to Gitea before this workflow existed. This task pushes the new tag only to
GitHub; it does not trigger another container build or deploy either service.
Real phone backup/restore, installation and offline/reconnect remain post-build
acceptance steps, not results inferred from a successful compilation.
