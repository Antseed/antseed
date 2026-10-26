import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { FreeTierStake } from '../api/types'
import { ConsoleContext, type ConsoleContextValue } from '../app/context'
import type { Viewer } from '../lib/nav'
import { qk } from '../lib/queries'
import { FreeTierInfo } from './FreeTierInfo'

const program = {
  base: { maxRequestsPerAddress: 1000, maxRequestsPerIp: null, windowMs: 86_400_000 },
  stakeTiers: [{ minPower: 520_000, multiplier: 5 as const }],
}

function render(viewer: Viewer, props: Partial<Parameters<typeof FreeTierInfo>[0]> = {}, stake?: FreeTierStake): string {
  const value = { viewer, workspace: { id: 'ws_team' } } as ConsoleContextValue
  const client = new QueryClient()
  if (stake) client.setQueryData(qk.freeTierStake('ws_team'), stake)
  const info = createElement(FreeTierInfo, { program, agentId: 42, ...props })
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ConsoleContext.Provider, { value }, info)))
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

  it("shows the workspace's standing on this seller and suggests max lock before it drops", () => {
    const admin = { orgRole: 'member', workspaceRole: 'admin' } as const
    const buyer = `0x${'b1'.repeat(20)}`
    const stake: FreeTierStake = {
      buyer, currentEpoch: 10, genesis: Date.UTC(2027, 0, 1, 12) / 1000 - 10 * 604_800, epochDuration: 604_800,
      pools: [{ agentId: 42, positions: [{ id: 1, staker: buyer, ants: 26_000, startEpoch: 0, endEpoch: 30, closedAtEpoch: null, maxLocked: false, expiresAt: null }] }],
    }
    vi.useFakeTimers()
    vi.setSystemTime((stake.genesis + 10 * 604_800 + 3600) * 1000)
    const html = render(admin, {}, stake)
    expect(html).toContain('You get 5,000 a day until Jan 8, 2027, then 1,000 a day.')
    expect(html).toContain('Keep this tier: turn on max lock')
    expect(render(admin, { agentId: 7 }, stake)).not.toContain('You get')
    vi.useRealTimers()
  })
})
