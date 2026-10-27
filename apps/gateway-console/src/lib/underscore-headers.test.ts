import { describe, expect, it } from 'vitest'
import { hyphenTwins, parseHeaderNames } from './underscore-headers'

describe('underscore header names', () => {
  it('reads one per line or comma-separated, lower-cased and de-duplicated', () => {
    expect(parseHeaderNames(' Session_ID\nconversation_id, x_trace_*\n\nsession_id ')).toEqual(['session_id', 'conversation_id', 'x_trace_*'])
    expect(parseHeaderNames('')).toEqual([])
  })

  it('names the hyphenated forms Caddy drops instead', () => {
    expect(hyphenTwins(['session_id', 'x_trace_*'])).toEqual(['session-id', 'x-trace-*'])
  })
})
