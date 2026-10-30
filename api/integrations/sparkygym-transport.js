import dns from 'node:dns/promises'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'

function ipv6Bytes(address) {
  let text = address.toLowerCase()
  if (text.includes('.')) {
    const last = text.lastIndexOf(':'), v4 = text.slice(last + 1).split('.').map(Number)
    text = text.slice(0, last + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16)
  }
  const halves = text.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : []
  return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(n => parseInt(n, 16))
}
function addressClass(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c, d] = address.split('.').map(Number)
    if (a === 0 || a >= 224 || a === 169 && b === 254 || a === 100 && b === 100 && c === 100 && d === 200 || a === 192 && b === 0 && c === 0) return 'blocked'
    if (a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)) return 'private'
    return 'public'
  }
  if (net.isIP(address) !== 6 || address.includes('%')) return 'blocked'
  const words = ipv6Bytes(address)
  if (words[0] === 0xfd00 && words[1] === 0xec2 && words.slice(2, 7).every(w => w === 0) && words[7] === 0x254) return 'blocked'
  if (words.slice(0, 5).every(w => w === 0) && words[5] === 0xffff) return addressClass([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.'))
  if (words.every(w => w === 0) || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xff00) === 0xff00) return 'blocked'
  if (words.slice(0, 7).every(w => w === 0) && words[7] === 1 || (words[0] & 0xfe00) === 0xfc00) return 'private'
  // Only global unicast; reject transition/tunnel forms that can conceal IPv4.
  if ((words[0] & 0xe000) !== 0x2000 || words[0] === 0x2002 || words[0] === 0x2001 && words[1] === 0) return 'blocked'
  return 'public'
}
export async function validateDestination(origin, options = {}, lookup = dns.lookup) {
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('invalid_origin')
  if (url.protocol === 'http:' && options.allow_insecure_http !== true) throw new Error('insecure_http')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length) throw new Error('blocked_destination')
  for (const { address } of addresses) {
    const kind = addressClass(address)
    if (kind === 'blocked') throw new Error('blocked_destination')
    if (kind === 'private' && options.allow_private_network !== true) throw new Error('private_destination')
  }
  return { url, addresses }
}
export async function sendPacket(origin, options, { method, path, headers, body = Buffer.alloc(0), maxResponseBytes = 1_048_576, signal }) {
  if (!/^(?:\/api\/integrations\/v1\/(?:events|pair\/claim|pair\/accept|capabilities|snapshot|media|revoke))$/.test(path)) throw new Error('invalid_path')
  const { url, addresses } = await validateDestination(origin, options)
  const pinned = addresses[0]
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method, path, headers: { ...headers, 'Content-Length': body.length }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000), agent: false,
      lookup: (_hostname, opts, callback) => opts?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      timeout: 30_000,
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); reject(new Error('redirect_refused')); return }
      let size = 0
      const chunks = []
      response.on('data', chunk => { size += chunk.length; if (size > maxResponseBytes) response.destroy(new Error('response_too_large')); else chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    request.on('timeout', () => request.destroy(new Error('request_timeout')))
    request.on('error', reject)
    request.end(body)
  })
}
