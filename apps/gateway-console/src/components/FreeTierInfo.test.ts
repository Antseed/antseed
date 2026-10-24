import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConsoleContext, type ConsoleContextValue } from '../app/context'
import type { Viewer } from '../lib/nav'
import { FreeTierInfo } from './FreeTierInfo'

const program = {
  base: { maxRequestsPerAddress: 1000, maxRequestsPerIp: null, windowMs: 86_400_000 },
  stakeTiers: [{ minPower: 520_000, multiplier: 5 as const }],
}

function render(viewer: Viewer): string {
  const value = { viewer } as ConsoleContextValue
  return renderToStaticMarkup(createElement(ConsoleContext.Provider, { value }, createElement(FreeTierInfo, { program, agentId: 42 })))
}

describe('FreeTierInfo', () => {
  it('links workspace admins to the seller pool and tells members who stakes', () => {
    expect(render({ orgRole: 'member', workspaceRole: 'admin' })).toContain('staking/stake?pool=42')
    const member = render({ orgRole: 'member', workspaceRole: 'member' })
    expect(member).not.toContain('staking/stake')
    expect(member).toContain('A workspace admin stakes for this workspace.')
  })
})
