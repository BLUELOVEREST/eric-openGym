import { describe, it, expect } from 'vitest'
import { compareReleaseVersions, ericRelease } from './release-version.js'

describe('custom release identity', () => {
  it('uses a global monotonic Android version independent of the upstream version', () => {
    expect(ericRelease('v1.4.3-eric.2', '1.4.3')).toEqual({ tag: 'v1.4.3-eric.2', versionName: '1.4.3-eric.2', versionCode: 100000002, apkName: 'openGym-1.4.3-eric.2-arm64.apk' })
    expect(ericRelease('v2.0.0-eric.3', '2.0.0').versionCode).toBe(100000003)
  })
  it('rejects official, malformed, mismatched and overflowing release identities', () => {
    for (const tag of ['v1.4.3', 'v1.4.3-eric.0', 'v1.4.3-eric.02', 'v1.4.3-eric.2000000000', 'v1.4.3-eric.2+extra', 'v1.4.4-eric.2', 'v1.4.3-eric.2\n']) expect(() => ericRelease(tag, '1.4.3')).toThrow()
  })
})
describe('fork updater precedence', () => {
  it('orders numeric Eric releases rather than lexically or as an upstream prerelease', () => {
    expect(compareReleaseVersions('1.4.3-eric.10', '1.4.3-eric.2')).toBe(1)
    expect(compareReleaseVersions('1.4.3-eric.2', '1.4.3-eric.10')).toBe(-1)
    expect(compareReleaseVersions('1.4.3-eric.2', '1.4.3+v1.4.3-eric.2')).toBe(0)
    expect(compareReleaseVersions('1.4.3-eric.3', '1.4.3+v1.4.3-eric.2')).toBe(1)
  })
  it('retains upstream semver/build metadata behavior and rejects malformed versions', () => {
    expect(compareReleaseVersions('v1.4.4+build', '1.4.3+another')).toBe(1)
    expect(compareReleaseVersions('1.4.3-eric.2', '1.4.3')).toBe(1)
    expect(compareReleaseVersions('1.5.0-eric.3', '1.4.3-eric.2')).toBe(1)
    expect(compareReleaseVersions('garbage', '1.4.3')).toBeNull()
    expect(compareReleaseVersions('1.4.3+v9.9.9-eric.100', '1.4.3-eric.2')).toBe(-1)
  })
})
