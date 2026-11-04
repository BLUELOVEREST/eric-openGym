import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ericRelease } from '../../frontend/src/lib/release-version.js'

export function verifyApkMetadata(badging, certificates, release, fingerprint, target = 'phone') {
  if (!['phone', 'wear'].includes(target)) throw new Error('Unknown APK target')
  const versionCode = release.versionCode + (target === 'wear' ? 10000 : 0)
  const identity = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m.exec(badging)
  if (!Number.isSafeInteger(versionCode) || versionCode > 2100000000 || !identity || identity[1] !== 'ch.duartesantos.opengym' || identity[2] !== String(versionCode) || identity[3] !== release.versionName) throw new Error('APK identity/version mismatch')
  if (/^application-debuggable/m.test(badging)) throw new Error('APK is debuggable')
  const native = /^native-code: (.+)$/m.exec(badging)
  if (target === 'phone' && (!native || native[1].trim() !== "'arm64-v8a'")) throw new Error('APK must contain ARM64 only')
  const signers = [...certificates.matchAll(/Signer #\d+ certificate SHA-256 digest: ([a-f0-9]+)/gi)]
  if (!/^[a-f0-9]{64}$/i.test(fingerprint || '') || signers.length !== 1 || signers[0][1].toLowerCase() !== fingerprint.toLowerCase()) throw new Error('APK signing certificate mismatch')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync('frontend/package.json', 'utf8'))
  const target = process.argv[4] || 'phone'
  verifyApkMetadata(readFileSync(process.argv[2], 'utf8'), readFileSync(process.argv[3], 'utf8'), ericRelease(process.env.RELEASE_TAG, pkg.version), process.env.ANDROID_CERT_SHA256, target)
  console.log(`Verified ${target} release identity, non-debuggable APK and persistent signing certificate${target === 'phone' ? ', ARM64 only' : ''}`)
}
