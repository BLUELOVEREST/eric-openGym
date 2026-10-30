// Unpaired-store unit fixtures. Real ownership and unknown-mode writes are tested separately.
const body = Object.freeze({ managed: false, source: null, connection_id: null, revision: 0, definitions: [], measurements: [], target: null })
const state = { owner: null, body, connections: [], status: 'local', error: null }
export const setBodyOwner = () => {}
export const currentBody = () => body
export const bodyReadOnly = () => false
export const readBodyState = value => value
export const refreshBody = async () => body
export const useSparkyGym = Object.assign(selector => selector(state), { getState: () => state, subscribe: () => () => {} })
