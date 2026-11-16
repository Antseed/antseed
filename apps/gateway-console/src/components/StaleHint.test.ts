import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StaleHint } from './ui'

const render = (props: { stale?: boolean; channelsStale?: boolean }): string => renderToStaticMarkup(createElement(StaleHint, props))

describe('StaleHint', () => {
  it('names the channel figures, not the RPC, while the buyer is still reading its channels (#1463)', () => {
    const markup = render({ channelsStale: true })
    expect(markup).toContain('Showing last known values — channel figures are still being read from the chain.')
    expect(markup).not.toContain('RPC')
  })

  it('names the RPC whenever it is busy, though the channel figures are unconfirmed too', () => {
    // A rate-limiting RPC leaves both stale: its note carries the advice to use one's own endpoint.
    expect(render({ stale: true, channelsStale: true })).toContain('Showing last known values — the chain RPC is busy.')
    expect(render({ stale: true })).toContain('the chain RPC is busy')
    expect(render({})).toBe('')
  })
})
