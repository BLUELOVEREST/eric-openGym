// Incremental UTF-8 parsing works for bearer-authenticated fetch streams on web and native.
export function eventDecoder(onEvent) {
  const decoder = new TextDecoder()
  let pending = '', frame = { event: 'message', id: '', lines: [] }
  return bytes => {
    pending += decoder.decode(bytes, { stream: true })
    if (pending.length > 1048576) throw new Error('SSE frame too large')
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, '')
      pending = pending.slice(end + 1)
      if (!line) {
        if (frame.lines.length) {
          let data
          try { data = JSON.parse(frame.lines.join('\n')) } catch { data = undefined }
          if (data !== undefined) onEvent({ id: frame.id, event: frame.event, data })
        }
        frame = { event: 'message', id: '', lines: [] }
      } else if (!line.startsWith(':')) {
        const split = line.indexOf(':')
        const key = split < 0 ? line : line.slice(0, split)
        const value = split < 0 ? '' : line.slice(split + 1).replace(/^ /, '')
        if (key === 'event') frame.event = value
        if (key === 'id' && !value.includes('\0')) frame.id = value
        if (key === 'data') frame.lines.push(value)
      }
    }
  }
}
