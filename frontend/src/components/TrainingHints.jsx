import { useTrainingHints } from '../lib/training-hints.js'
import { weekdayForDate, TIME_SLOTS } from '../../../api/integrations/training-hints-model.js'
import { t } from '../lib/i18n.js'

const labels = { morning: 'Morning', noon: 'Noon', afternoon: 'Afternoon', evening: 'Evening' }
export default function TrainingHints({ date, showEmpty = true }) {
  const hints = useTrainingHints(date)
  if (!hints.length) return showEmpty ? <div className="small dim" style={{ marginBottom: 16 }}>{t('No training arrangement')}</div> : null
  const weekday = weekdayForDate(date)
  return <section aria-label={t('Training hints')} style={{ marginBottom: 16, overflowWrap: 'anywhere' }}>
    <div className="small dim">SparkyFitness · {t('Training hints')}</div>
    {hints.map(hint => {
      const slots = hint.days.find(day => day.weekday === weekday)?.slots ?? []
      return <div key={hint.entity_id} style={{ padding: '8px 0', borderBottom: '1px solid var(--sep)' }}>
        <div className="tt">{hint.name}</div>
        <div className="small dim">{hint.timezone}</div>
        {!slots.length ? <div className="small">{t('Rest day')}</div> : TIME_SLOTS.flatMap(bucket => slots.filter(slot => slot.time_slot === bucket)).map(slot =>
          <div key={slot.time_slot} className="small" style={{ paddingTop: 4 }}>
            <span className="dim">{t(labels[slot.time_slot])}</span>{' · '}{slot.activity}{slot.is_main && <strong>{' · '}{t('Main session')}</strong>}
          </div>)}
      </div>
    })}
  </section>
}
