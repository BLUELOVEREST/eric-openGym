import { useStore } from './useStore.js'
import { useSparkyGym } from '../lib/sparkygym-client.js'
import { bodyView } from '../lib/sparkygym-body.js'
import { useMemo } from 'react'

export function useBodyState() {
  const state = useStore(s => s.S)
  const owner = useSparkyGym(s => s.owner)
  const body = useSparkyGym(s => s.body)
  return useMemo(() => owner ? bodyView(state, body) : state, [state, owner, body])
}
