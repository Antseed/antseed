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

function render(viewer: Viewer, props: Partial<Parameters<typeof FreeTierInfo>[0]> = {}): string {
  const value = { viewer } as ConsoleContextValue
  return renderToStaticMarkup(createElement(ConsoleContext.Provider, { value }, createElement(FreeTierInfo, { program, agentId: 42, ...props })))
}

describe('FreeTierInfo', () => {
  it('links workspace admins to the seller pool and tells members who stakes', () => {
    expect(render({ orgRole: 'member', workspaceRole: 'admin' })).toContain('staking/stake?pool=42')
    const member = render({ orgRole: 'member', workspaceRole: 'member' })
    expect(member).not.toContain('staking/stake')
    expect(member).toContain('A workspace admin stakes for this workspace.')
  })

  it('names each tier in requests, and says when a priced model is free only for stakers', () => {
    const admin = { orgRole: 'member', workspaceRole: 'admin' } as const
    expect(render(admin)).toContain('5,000 a day')
    const stakersOnly = {
      base: { maxRequestsPerAddress: 200, maxRequestsPerIp: null, windowMs: 86_400_000, stakersOnly: true },
      stakeTiers: [{ minPower: 45_000_000, multiplier: 1 as const }],
    }
    const priced = render(admin, { program: stakersOnly, priced: true })
    expect(priced).toContain('Free for stakers, others pay')
    expect(priced).toContain('865,385 ANTS')
    expect(priced).toContain('200 a day')
    expect(priced).toContain('paid at the listed price')
    expect(render(admin, { program: { ...program, stakeTiers: [] }, priced: true })).toContain('1,000 free requests a day, then paid')
  })
})
