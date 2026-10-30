import { expect, it } from 'vitest'
import { eventDecoder } from './sparkygym-events.js'

it('decodes split UTF-8 SSE frames and explicit compacted-cursor recovery', () => {
  const events = []
  const feed = eventDecoder(e => events.push(e))
  const bytes = new TextEncoder().encode('id: 41\r\nevent: snapshot-required\r\ndata: {"label":"体重"}\r\n\r\n')
  for (const b of bytes) feed(new Uint8Array([b]))
  expect(events).toEqual([{ id: '41', event: 'snapshot-required', data: { label: '体重' } }])
})
it('does not advance cursors for incomplete or malformed JSON events', () => {
  const events = []
  const feed = eventDecoder(e => events.push(e))
  feed(new TextEncoder().encode('id: 2\ndata: nope\n\nid: 3\ndata: {}'))
  expect(events).toEqual([])
})
