import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyApkMetadata } from './verify-eric-apk.mjs'
import { ericRelease } from '../../frontend/src/lib/release-version.js'
const release = ericRelease('v1.4.3-eric.2', '1.4.3')
const badging = "package: name='ch.duartesantos.opengym' versionCode='100000002' versionName='1.4.3-eric.2'\nnative-code: 'arm64-v8a'\n"
const cert = `Signer #1 certificate SHA-256 digest: ${'a'.repeat(64)}\n`
test('verified release metadata is accepted', () => assert.doesNotThrow(() => verifyApkMetadata(badging, cert, release, 'a'.repeat(64))))
test('wrong package, version, ABI, debug and rotated certificates cannot publish', () => {
  for (const value of [badging.replace('ch.duartesantos.opengym', 'ch.other'), badging.replace('100000002', '28'), badging.replace('1.4.3-eric.2', '1.4.3'), badging.replace("'arm64-v8a'", "'arm64-v8a' 'x86_64'"), badging + 'application-debuggable\n']) assert.throws(() => verifyApkMetadata(value, cert, release, 'a'.repeat(64)))
  assert.throws(() => verifyApkMetadata(badging, cert, release, 'b'.repeat(64)))
  assert.throws(() => verifyApkMetadata(badging, cert + cert, release, 'a'.repeat(64)))
})
