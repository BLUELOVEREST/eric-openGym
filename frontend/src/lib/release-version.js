const BASE = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)'
const ERIC_TAG = new RegExp(`^v(${BASE})-eric\\.([1-9]\\d*)$`)

export function ericRelease(tag, baseVersion) {
  const match = typeof tag === 'string' && ERIC_TAG.exec(tag)
  const number = match ? Number(match[5]) : NaN
  if (!match || match[0] !== tag || match[1] !== baseVersion || !Number.isSafeInteger(number) || number > 1999999999) throw new Error('invalid_eric_release')
  return { tag, versionName: tag.slice(1), versionCode: 100000000 + number, apkName: `openGym-${tag.slice(1)}-arm64.apk` }
}

function parts(version) {
  if (typeof version !== 'string') return null
  const match = new RegExp(`^v?${BASE}(?:-eric\\.([1-9]\\d*))?(?:\\+([^\\s]+))?$`).exec(version)
  if (!match || match[0] !== version) return null
  const numbers = match.slice(1, 4).map(Number)
  let eric = Number(match[4] || 0)
  // Vite preserves the package version and appends APP_BUILD as metadata.
  const metadata = match[5] && ERIC_TAG.exec(match[5])
  if (!eric && metadata && metadata[1] === numbers.join('.')) eric = Number(metadata[5])
  return [...numbers, eric].every(Number.isSafeInteger) ? [...numbers, eric] : null
}

export function compareReleaseVersions(left, right) {
  const a = parts(left), b = parts(right)
  if (!a || !b) return null
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}
