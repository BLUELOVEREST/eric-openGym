import { useSparkyGym } from '../lib/sparkygym-client.js'
import { t } from '../lib/i18n.js'

export default function BodySource() {
  const owner = useSparkyGym(s => s.owner)
  const body = useSparkyGym(s => s.body)
  const status = useSparkyGym(s => s.status)
  if (!owner || body?.managed === false) return null
  return <p className="small dim" role="status">{body?.managed ? t('Managed by SparkyFitness') : t('Body source unavailable')}{status === 'offline' ? ' · ' + t('Sync pending') : ''}</p>
}
