import { useEffect, useState } from 'react'
import { useSparkyGym, refreshIntegration, integrationControl, claimInvitation } from '../lib/sparkygym-client.js'
import { t } from '../lib/i18n.js'
import { Section, Row, Button, Switch } from './ui.jsx'
import { confirmSheet } from '../sheets.jsx'

const resourceLabel = resource => ({ body_definition: t('Fields'), body_measurement: t('Body measurements'), body_goal: t('Target weight'), exercise: t('Exercises'), workout: t('Workouts'), schedule_summary: t('Schedule'), personal_media: t('Photos & videos') })[resource] || resource
const stateLabel = value => ({ active: t('Connected'), paused: t('Paused'), revoked: t('Revoked'), expired: t('Expired'), invited: t('Pending approval'), pending_approval: t('Pending approval') })[value] || t('Sync failed')
const count = connection => Object.values(connection.affected_record_counts || {}).reduce((sum, value) => sum + value, 0)

export default function SparkyGymConnection() {
  const connections = useSparkyGym(s => s.connections)
  const status = useSparkyGym(s => s.status)
  const error = useSparkyGym(s => s.error)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [invitation, setInvitation] = useState('')
  const [http, setHttp] = useState(false)
  const [privateNetwork, setPrivateNetwork] = useState(false)
  const run = async operation => {
    if (busy) return
    setBusy(true); setFailed(false)
    try { await operation() } catch { setFailed(true) }
    finally { setBusy(false) }
  }
  useEffect(() => { let live = true; refreshIntegration().catch(() => { if (live) setFailed(true) }); return () => { live = false } }, [])
  const claim = () => run(async () => {
    const offer = JSON.parse(invitation)
    const keys = ['version', 'connection_id', 'sf_owner_ref', 'sf_origin', 'sf_nonce', 'scopes', 'include_history', 'secret', 'expires_at', 'peer_origin']
    if (!offer || typeof offer !== 'object' || Array.isArray(offer) || Object.keys(offer).length !== keys.length || !keys.every(key => Object.hasOwn(offer, key)) || offer.version !== 1) throw new Error('invalid_invitation')
    await claimInvitation(offer, http, privateNetwork)
    setInvitation(''); setShowImport(false); setHttp(false); setPrivateNetwork(false)
  })
  const control = (connection, action, payload = {}) => run(() => integrationControl(connection.connection_id, action, payload))
  const confirm = (connection, action) => confirmSheet({
    title: action === 'purge' ? t('Purge source data') : action === 'revoke' ? t('Revoke connection') : t('Import history'),
    message: action === 'purge' ? t('Permanently remove {0} source records from {1}?', count(connection), connection.peer_origin)
      : action === 'revoke' ? t('Revoke connection') + ': ' + connection.peer_origin + ' (' + count(connection) + ')'
      : t('Confirm source history sync from {0} ({1} records)?', connection.peer_origin, count(connection)),
    confirmText: t('Confirm'), danger: action !== 'snapshot',
    onConfirm: () => control(connection, action, action === 'purge' ? { confirm: true } : action === 'snapshot' ? { include_history: true } : {}),
  })
  return <>
    <Section title="SparkyFitness">
      <Row icon="sync" title={status === 'connected' ? t('Connected') : t('Sync pending')} accessory="chevron" onClick={() => run(refreshIntegration)} />
      {(failed || error) && <Row icon="warning" title={t('Sync failed')} subtitle={t('Try again')} />}
      <Row icon="plus" title={t('Import invitation')} subtitle={t('New invitation must be created in SparkyFitness.')} accessory="chevron" onClick={() => setShowImport(value => !value)} />
    </Section>
    {showImport && <Section title={t('Import invitation')}>
      <div style={{ padding: 12 }}>
        <label className="small dim" htmlFor="sparkygym-invitation">{t('Invitation JSON')}</label>
        <textarea id="sparkygym-invitation" className="field" value={invitation} maxLength={12000} autoComplete="off" spellCheck={false} onChange={event => setInvitation(event.target.value)} style={{ width: '100%', minHeight: 120, resize: 'vertical' }} />
      </div>
      <Row title={t('Allow unencrypted HTTP')}><Switch checked={http} onChange={setHttp} disabled={busy} /></Row>
      <Row title={t('Allow private networks')}><Switch checked={privateNetwork} onChange={setPrivateNetwork} disabled={busy} /></Row>
      <div style={{ padding: 12 }}><Button icon="link" disabled={busy || !invitation.trim()} onClick={claim}>{t('Import invitation')}</Button></div>
    </Section>}
    {connections.map(connection => <Section key={connection.connection_id} title={stateLabel(connection.status)}>
      <Row icon="server" title={connection.peer_origin} subtitle={connection.peer_owner_ref || t('Pending approval')} />
      <Row title={t('Resource scopes')} subtitle={(connection.scopes || []).map(resourceLabel).join(', ')} />
      <Row title={t('Import history')} value={connection.include_history ? t('On') : t('Off')} />
      <Row title={t('Record counts')} subtitle={Object.entries(connection.affected_record_counts || {}).map(([resource, amount]) => resourceLabel(resource) + ': ' + amount).join(', ')} />
      {connection.capabilities && <Row title={t('Available')} subtitle={connection.capabilities.resources.map(resourceLabel).join(', ')} />}
      <Row title={t('Pending personal media')} value={connection.delivery?.pending_media ?? 0} />
      {!!connection.delivery?.pending && <Row title={t('Sync pending')} value={connection.delivery.pending} />}
      {!!connection.delivery?.failed && <Row title={t('Sync failed')} value={connection.delivery.failed} />}
      {connection.status === 'active' && <Row icon="pause" title={t('Pause')} onClick={() => !busy && control(connection, 'pause')} />}
      {connection.status === 'paused' && <Row icon="play" title={t('Resume')} onClick={() => !busy && control(connection, 'resume')} />}
      {connection.status === 'active' && <Row icon="sync" title={t('Import history')} onClick={() => !busy && confirm(connection, 'snapshot')} />}
      {!['revoked', 'expired'].includes(connection.status) && <Row icon="xmark" title={t('Revoke connection')} danger onClick={() => !busy && confirm(connection, 'revoke')} />}
      <Row icon="key" title={t('Re-pair with new keys')} onClick={() => setShowImport(true)} />
      {connection.status === 'revoked' && <Row icon="trash" title={t('Purge source data')} danger onClick={() => !busy && confirm(connection, 'purge')} />}
    </Section>)}
  </>
}
