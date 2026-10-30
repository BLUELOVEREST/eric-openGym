import { useEffect, useMemo } from 'react'
import { calendarDay } from '../../../api/integrations/training-hints-model.js'
import { useSparkyGym, refreshTrainingHints } from './sparkygym-client.js'

export function hintsForDate(metadata, date) {
  if (!calendarDay(date)) return []
  return (metadata?.hints || []).filter(hint => date >= hint.effective_from &&
    (hint.effective_until === null || date <= hint.effective_until))
}

export function useTrainingHints(date) {
  const metadata = useSparkyGym(state => state.trainingHints)
  const scope = useSparkyGym(state => state.scope)
  useEffect(() => { if (scope) refreshTrainingHints().catch(() => {}) }, [scope])
  return useMemo(() => hintsForDate(metadata, date), [metadata, date])
}
