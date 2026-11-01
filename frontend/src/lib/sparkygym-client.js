import { create } from 'zustand'
import { api, apiEvents } from './api.js'
import { MOBILE, readJsonFile, writeJsonFile, onAppActive } from './mobile.js'
import { bodyView, validateBodyProfile } from './sparkygym-body.js'
import { validateHintsResponse } from '../../../api/integrations/training-hints-model.js'

const ROOT = '/api/integrations/sparkygym'
const CACHE = 'opengym_external_body_v1:'
const FILE = 'opengym-external-body.json'
const HINT_CACHE = 'opengym_training_hints_v1:'
const HINT_FILE = 'opengym-training-hints.json'
const validMetadata = value => validateHintsResponse(value) && value.date === null
export const useSparkyGym = create(() => ({ owner: null, scope: '', body: null, trainingHints: null, hintError: null, connections: [], status: 'local', error: null }))
let generation = 0, pending = null, hintsPending = null
const scopeOf = (owner, base) => owner ? JSON.stringify([base || globalThis.location?.origin || '', owner]) : ''
function cached(scope) {
  try { const value = JSON.parse(localStorage.getItem(CACHE + scope)); return validateBodyProfile(value) ? value : null } catch { return null }
}
function cachedHints(scope) {
  try { const value = JSON.parse(localStorage.getItem(HINT_CACHE + scope)); return validMetadata(value) ? value : null } catch { return null }
}
export function setBodyOwner(owner, base) {
  const scope = scopeOf(owner, base)
  if (scope === useSparkyGym.getState().scope) return
  generation++; pending = null; hintsPending = null
  useSparkyGym.setState({ owner, scope, body: scope ? cached(scope) : null, trainingHints: scope ? cachedHints(scope) : null, hintError: null, connections: [], status: scope ? 'offline' : 'local', error: null })
}
export const currentBody = () => useSparkyGym.getState().owner ? useSparkyGym.getState().body : { managed: false }
export const bodyReadOnly = () => currentBody()?.managed !== false
export const readBodyState = state => bodyView(state, currentBody())
export const integrationStatus = () => api(ROOT)
export async function integrationControl(id, action, value = {}) {
  const result = await api(ROOT + '/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: JSON.stringify(value) })
  if (!result.connection?.connection_id) throw new Error('Invalid connection response')
  await refreshIntegration()
  return result
}
export async function claimInvitation(invitation) {
  const result = await api(ROOT + '/claim', { method: 'POST', body: JSON.stringify({ invitation }) })
  if (!result.connection?.connection_id) throw new Error('Invalid connection response')
  await refreshIntegration()
  return result
}
export function refreshBody() {
  const { owner, scope } = useSparkyGym.getState()
  if (!owner) return Promise.resolve(null)
  if (pending) return pending
  const epoch = generation
  const request = (async () => {
    try {
      const body = await api('/api/body/profile')
      if (!validateBodyProfile(body)) throw new Error('Invalid body profile')
      if (epoch !== generation) return null
      useSparkyGym.setState({ body, status: 'connected', error: null })
      try { localStorage.setItem(CACHE + scope, JSON.stringify(body)) } catch { /* memory copy remains */ }
      if (MOBILE) await writeJsonFile(FILE, { scope, body }).catch(() => {})
      return body
    } catch (error) {
      if (epoch === generation) useSparkyGym.setState({ status: 'offline', error: error.message })
      throw error
    } finally { if (epoch === generation) pending = null }
  })()
  pending = request
  return request
}
export function refreshTrainingHints() {
  const { owner, scope } = useSparkyGym.getState()
  if (!owner) return Promise.resolve(null)
  if (hintsPending) return hintsPending
  const epoch = generation
  const request = (async () => {
    try {
      const trainingHints = await api('/api/training-hints')
      if (!validMetadata(trainingHints)) throw new Error('Invalid training hints metadata')
      if (epoch !== generation) return null
      useSparkyGym.setState({ trainingHints, hintError: null })
      try { localStorage.setItem(HINT_CACHE + scope, JSON.stringify(trainingHints)) } catch { /* memory copy remains */ }
      if (MOBILE) await writeJsonFile(HINT_FILE, { scope, hints: trainingHints }).catch(() => {})
      return trainingHints
    } catch (error) {
      if (epoch === generation) useSparkyGym.setState({ hintError: error.message })
      throw error
    } finally { if (epoch === generation) hintsPending = null }
  })()
  hintsPending = request
  return request
}
export async function refreshIntegration() {
  const epoch = generation
  const [body, status] = await Promise.all([refreshBody(), integrationStatus(), refreshTrainingHints()])
  if (!Array.isArray(status.connections)) throw new Error('Invalid connection status')
  if (epoch === generation) useSparkyGym.setState({ connections: status.connections })
  return body
}

// The cursor advances only after the authoritative snapshots have been read successfully.
// Reconnect is a one-shot transport retry, never a business-data polling interval.
export function startIntegration(owner) {
  if (owner !== useSparkyGym.getState().owner) setBodyOwner(owner)
  if (!owner) return () => {}
  const epoch = generation, scope = useSparkyGym.getState().scope
  let stopped = false, controller, timer, cursor = '', delay = 1000, attempt = 0
  try { cursor = localStorage.getItem(CACHE + scope + ':cursor') || '' } catch { /* no persistence */ }
  const remember = value => {
    cursor = value
    try { localStorage.setItem(CACHE + scope + ':cursor', cursor) } catch { /* replay is safe */ }
  }
  const refresh = async (fresh = false) => {
    // A read started before this event cannot acknowledge that event's cursor.
    if (fresh) await Promise.all([pending, hintsPending].filter(Boolean).map(read => read.catch(() => {})))
    return refreshIntegration().catch(error => {
    if (epoch === generation) useSparkyGym.setState({ status: 'offline', error: error.message })
    throw error
    })
  }
  const connect = async () => {
    if (stopped || epoch !== generation) return
    const run = ++attempt
    const ctl = new AbortController()
    controller = ctl
    let work = Promise.resolve()
    let queued = null, refreshing = false
    const flush = () => {
      if (refreshing) return
      refreshing = true
      work = (async () => {
        while (queued) {
          const event = queued
          queued = null
          if (stopped || epoch !== generation || run !== attempt) return
          await refresh(true)
          if (stopped || epoch !== generation || run !== attempt) return
          if (event.event === 'snapshot-required') {
            const next = event.data.cursor ?? event.data.latest_cursor
            remember(next == null ? '' : String(next))
          } else if (/^\d+$/.test(event.id)) remember(event.id)
          delay = 1000
        }
      })().finally(() => {
        refreshing = false
        if (queued && !stopped && !ctl.signal.aborted) flush()
      })
      work.catch(() => ctl.abort())
    }
    try {
      await refresh()
      if (stopped || epoch !== generation || run !== attempt) return
      await apiEvents(ROOT + '/notifications', { signal: ctl.signal, cursor, onEvent(event) {
        queued = event
        flush()
      } })
      while (refreshing) await work
    } catch { if (epoch === generation && run === attempt) useSparkyGym.setState({ status: 'offline' }) }
    if (!stopped && epoch === generation && run === attempt) { timer = setTimeout(connect, delay); delay = Math.min(30000, delay * 2) }
  }
  if (MOBILE && !useSparkyGym.getState().body) readJsonFile(FILE).then(value => {
    if (epoch === generation && !useSparkyGym.getState().body && value?.scope === scope && validateBodyProfile(value.body)) useSparkyGym.setState({ body: value.body })
  }).catch(() => {})
  if (MOBILE && !useSparkyGym.getState().trainingHints) readJsonFile(HINT_FILE).then(value => {
    if (epoch === generation && !useSparkyGym.getState().trainingHints && value?.scope === scope && validMetadata(value.hints)) useSparkyGym.setState({ trainingHints: value.hints })
  }).catch(() => {})
  const wake = () => {
    if (globalThis.document?.visibilityState === 'hidden') return
    clearTimeout(timer); controller?.abort(); connect()
  }
  globalThis.window?.addEventListener('online', wake)
  globalThis.window?.addEventListener('focus', wake)
  globalThis.document?.addEventListener('visibilitychange', wake)
  const off = MOBILE ? onAppActive(wake) : null
  connect()
  return () => {
    stopped = true; clearTimeout(timer); controller?.abort(); off?.()
    globalThis.window?.removeEventListener('online', wake)
    globalThis.window?.removeEventListener('focus', wake)
    globalThis.document?.removeEventListener('visibilitychange', wake)
  }
}
