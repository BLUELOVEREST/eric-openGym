export function randomId() {
  const crypto = globalThis.crypto
  return (crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')).replace(/-/g, '')
}
