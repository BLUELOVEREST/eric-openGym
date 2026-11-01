// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ controls: vi.fn(), claim: vi.fn(), confirm: vi.fn(), snapshot: null }))
vi.mock('../lib/sparkygym-client.js', () => ({
  useSparkyGym: selector => selector(mocks.snapshot),
  refreshIntegration: () => Promise.resolve(),
  integrationControl: (...args) => mocks.controls(...args),
  claimInvitation: (...args) => mocks.claim(...args),
}))
vi.mock('../sheets.jsx', () => ({ confirmSheet: (...args) => mocks.confirm(...args) }))
import SparkyGymConnection from './SparkyGymConnection.jsx'
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host, root
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.clearAllMocks() })
const mount = async status => {
  mocks.snapshot = { status: 'connected', error: null, connections: [{ connection_id: 'c', status, peer_origin: 'https://sf.example', peer_owner_ref: 'owner', scopes: ['body_measurement'], include_history: true, affected_record_counts: { body_measurement: 4 }, capabilities: { resources: ['workout'] }, delivery: { pending_media: 2 } }] }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<SparkyGymConnection />))
}
it('shows the bound peer, history counts and pending media but never offers purge for an active source', async () => {
  await mount('active')
  expect(host.textContent).toContain('https://sf.example')
  expect(host.textContent).toContain('owner')
  expect(host.textContent).toContain('4')
  expect(host.textContent).toContain('Pending personal media')
  expect(host.textContent).not.toContain('Purge source data')
})
it('requires confirmation before purging a revoked source', async () => {
  await mount('revoked')
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent.includes('Purge source data')).click())
  expect(mocks.controls).not.toHaveBeenCalled()
  const dialog = mocks.confirm.mock.calls[0][0]
  expect(dialog.message).toContain('https://sf.example')
  await act(async () => dialog.onConfirm())
  expect(mocks.controls).toHaveBeenCalledWith('c', 'purge', { confirm: true })
})
it.each(['paused', 'pending_approval', 'revoked', 'expired'])('keeps deliberate pairing available for %s', async status => {
  await mount(status)
  expect(host.querySelector('textarea')).toBeNull()
  expect(host.textContent.includes('Import invitation')).toBe(status !== 'paused')
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent.includes('Re-pair with new keys')).click())
  expect(host.querySelector('textarea')).not.toBeNull()
  expect(mocks.claim).not.toHaveBeenCalled()
  expect(mocks.controls).not.toHaveBeenCalled()
})
it('shows only confirmed history action, without permanent authorization or network controls', async () => {
  await mount('active')
  expect(host.textContent).not.toContain('Resource scopes')
  expect(host.textContent).not.toContain('Available')
  expect(host.textContent.match(/Import history/g)).toHaveLength(1)
  expect(host.textContent).not.toContain('Import invitation')
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent.includes('Re-pair with new keys')).click())
  expect(host.querySelector('textarea#sparkygym-invitation')).not.toBeNull()
  expect(host.textContent).not.toContain('Allow unencrypted HTTP')
  expect(host.textContent).not.toContain('Allow private networks')
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent.includes('Import history')).click())
  expect(mocks.controls).not.toHaveBeenCalled()
  await act(async () => mocks.confirm.mock.calls[0][0].onConfirm())
  expect(mocks.controls).toHaveBeenCalledWith('c', 'snapshot', { include_history: true })
})
