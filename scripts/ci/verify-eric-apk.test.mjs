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
const watchBadging = badging.replace('100000002', '100010002').replace("native-code: 'arm64-v8a'\n", '')
test('Wear OS accepts no native libraries and requires its offset and persistent certificate', () => {
  assert.doesNotThrow(() => verifyApkMetadata(watchBadging, cert, release, 'a'.repeat(64), 'wear'))
  assert.doesNotThrow(() => verifyApkMetadata(watchBadging + "native-code: 'armeabi-v7a'\n", cert, release, 'a'.repeat(64), 'wear'))
  assert.throws(() => verifyApkMetadata(badging.replace("native-code: 'arm64-v8a'\n", ''), cert, release, 'a'.repeat(64)))
  assert.throws(() => verifyApkMetadata(watchBadging, cert, { ...release, versionCode: 2100000000 }, 'a'.repeat(64), 'wear'))
  for (const value of [watchBadging.replace('100010002', '100000002'), watchBadging.replace('ch.duartesantos.opengym', 'ch.other'), watchBadging.replace('1.4.3-eric.2', '1.4.3'), watchBadging + 'application-debuggable\n']) {
    assert.throws(() => verifyApkMetadata(value, cert, release, 'a'.repeat(64), 'wear'))
  }
  assert.throws(() => verifyApkMetadata(watchBadging, cert, release, 'b'.repeat(64), 'wear'))
  assert.throws(() => verifyApkMetadata(watchBadging, cert + cert, release, 'a'.repeat(64), 'wear'))
  assert.throws(() => verifyApkMetadata(badging, cert, release, 'a'.repeat(64), 'unknown'))
})
