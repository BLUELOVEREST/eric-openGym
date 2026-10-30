import { afterEach, expect, it, vi } from 'vitest'
import { randomId } from './ids.js'

afterEach(() => vi.unstubAllGlobals())
it('uses secure random bytes on LAN HTTP where randomUUID is unavailable', () => {
  const getRandomValues = vi.fn(bytes => { bytes.fill(0xab); return bytes })
  vi.stubGlobal('crypto', { getRandomValues })
  expect(randomId()).toBe('ab'.repeat(16))
  expect(getRandomValues).toHaveBeenCalledOnce()
})
it('keeps the existing compact UUID format in secure contexts', () => {
  vi.stubGlobal('crypto', { randomUUID: () => '12345678-1234-4234-8234-123456789abc' })
  expect(randomId()).toBe('12345678123442348234123456789abc')
})
