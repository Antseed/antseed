import { describe, expect, it } from 'vitest'
import { formatEth, formatUtcDay, lastResult, sellerNotices, usageTotals, type AvailableSeller } from './seller'
import { visibleNav } from './nav'

const DAY = 86_400_000
const now = 20_000 * DAY + 3_600_000

function seller(overrides: Partial<AvailableSeller> = {}): AvailableSeller {
  return {
    available: true, running: true, dataDir: '/data', peerId: '0xabc', provider: 'openai', startedAt: now - 3_600_000, updatedAt: now,
    activeChannels: 0, capacityUsedPercent: 0, notices: [], models: [], gas: null, alerts: null, version: '1.0.0', ...overrides,
  }
}

describe('seller page helpers', () => {
  it('totals today and the last 7 UTC days', () => {
    const days = [12, 6, 1, 0].map((ago) => ({ day: 20_000 * DAY - ago * DAY, requests: 10, tokens: 0, sessions: 1, revenueUsd: 2 }))
    expect(usageTotals(days, now)).toEqual({ requestsToday: 10, revenueToday: 2, revenueWeek: 6, requestsWeek: 30 })
  })

  it('has no notices for a healthy seller', () => {
    expect(sellerNotices(seller(), now)).toEqual([])
  })

  it('lists stopped, out of gas and withdrawn models, without repeating the daemon gas notice', () => {
    const lines = sellerNotices(seller({
      running: false,
      updatedAt: now - 5 * 60_000,
      gas: { address: '0xabc', depleted: true, balanceEth: 0.00001, minBalanceEth: 0.00005, lastCheckedAt: now },
      notices: ['Out of gas: wallet 0xabc holds …'],
      models: [
        { provider: 'openai', providerId: 'openai', service: 'glm-5.3', advertised: false, consecutiveFailures: 4, lastProbeAt: now, lastStatusCode: 402, lastDetail: 'HTTP 402' },
        { provider: 'openai', providerId: 'openai', service: 'kimi-k3', advertised: true, consecutiveFailures: 0, lastProbeAt: now, lastStatusCode: null, lastDetail: null },
      ],
    }), now)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('5 min ago')
    expect(lines[1]).toMatch(/^Out of gas/)
    expect(lines[2]).toBe('1 model is withdrawn after failing health checks: glm-5.3.')
  })

  it('formats ETH and probe results compactly', () => {
    expect(formatEth(0.0297126)).toBe('0.0297')
    expect(formatEth(0.00005)).toBe('0.00005')
    expect(formatEth(null)).toBe('—')
    expect(lastResult({ provider: 'p', providerId: 'p', service: 's', advertised: false, consecutiveFailures: 1, lastProbeAt: 1, lastStatusCode: 402, lastDetail: 'out of credit' })).toBe('HTTP 402 · out of credit')
    expect(lastResult({ provider: 'p', providerId: 'p', service: 's', advertised: false, consecutiveFailures: 1, lastProbeAt: 1, lastStatusCode: 402, lastDetail: 'HTTP 402: no balance' })).toBe('HTTP 402: no balance')
  })

  it('labels chart days in UTC', () => {
    expect(formatUtcDay(Date.UTC(2026, 9, 12))).toBe('Oct 12')
  })

  it('shows the Seller nav item to org admins only when the host runs a seller', () => {
    const owner = { orgRole: 'owner' as const, workspaceRole: null }
    expect(visibleNav(owner).some((item) => item.id === 'seller')).toBe(false)
    expect(visibleNav(owner, { hasSeller: true }).some((item) => item.id === 'seller')).toBe(true)
    expect(visibleNav({ orgRole: 'member', workspaceRole: 'admin' }, { hasSeller: true }).some((item) => item.id === 'seller')).toBe(false)
  })
})

describe('seller editors', async () => {
  const { draftOf, draftErrors, patchOf, reconcileDraft } = await import('../components/SellerSettingsEditor')
  const { alertsPatchOf } = await import('../components/SellerAlertsEditor')
  const settings = {
    configPath: '/c', writable: true, readOnlyReason: null, displayName: 'S', maxConcurrentBuyers: 50,
    healthCheck: { enabled: true, intervalMs: 300_000, failureThreshold: 3 }, gasCheck: { enabled: true, minBalanceEth: 0.00005 },
    freeTier: { maxRequestsPerAddress: null, maxRequestsPerIp: null, windowMs: null, stakersOnly: false, stakeTiers: null }, restrictedCountries: ['RU'], restrictedCountriesDefault: true,
    defaultStakeTiers: [{ minPower: 520_000, multiplier: 5 as number | 'unlimited' }],
    services: [{ provider: 'openai', service: 'glm-5.3', inputUsdPerMillion: 1, outputUsdPerMillion: 3, cachedInputUsdPerMillion: null, inherited: false, paid: true, freeTier: null, ownFreeTier: null }],
  }

  it('sends only what changed', () => {
    const base = draftOf(settings)
    expect(patchOf(base, base)).toEqual({})
    const draft = { ...base, maxConcurrentBuyers: '20', healthIntervalSec: '60', prices: { 'openai/glm-5.3': { input: '0.8', output: '3', cached: '' } } }
    expect(patchOf(base, draft)).toEqual({
      maxConcurrentBuyers: 20,
      healthCheck: { enabled: true, intervalMs: 60_000, failureThreshold: 3 },
      pricing: [{ provider: 'openai', service: 'glm-5.3', inputUsdPerMillion: 0.8, outputUsdPerMillion: 3, cachedInputUsdPerMillion: null }],
    })
    expect(draftErrors({ ...base, maxConcurrentBuyers: '0', countries: 'RUS' })).toMatchObject({ maxConcurrentBuyers: expect.any(String), countries: expect.any(String) })
  })

  it('keeps edits and adds rows when the saved settings gain a service', () => {
    const base = draftOf(settings)
    const next = draftOf({ ...settings, services: [...settings.services, { provider: 'openai', service: 'kimi-k3', inputUsdPerMillion: 2, outputUsdPerMillion: 5, cachedInputUsdPerMillion: null, inherited: false, paid: true, freeTier: null, ownFreeTier: null }] })
    expect(reconcileDraft(base, base, next)).toEqual(next)
    const edited = { ...base, displayName: 'Mine', prices: { 'openai/glm-5.3': { input: '0.5', output: '3', cached: '' } } }
    const merged = reconcileDraft(edited, base, next)
    expect(merged.displayName).toBe('Mine')
    expect(merged.prices).toEqual({ 'openai/glm-5.3': { input: '0.5', output: '3', cached: '' }, 'openai/kimi-k3': { input: '2', output: '5', cached: '' } })
  })

  it('a dirty draft takes values saved elsewhere for the fields it did not touch, so saving never reverts them', () => {
    const two = { ...settings, services: [...settings.services, { provider: 'openai', service: 'kimi-k3', inputUsdPerMillion: 2, outputUsdPerMillion: 5, cachedInputUsdPerMillion: null, inherited: false, paid: true, freeTier: null, ownFreeTier: null }] }
    const base = draftOf(two)
    const edited = { ...base, displayName: 'Mine', prices: { ...base.prices, 'openai/glm-5.3': { input: '0.5', output: '3', cached: '' } } }
    // Meanwhile kimi-k3's price and the concurrency limit change from the CLI.
    const next = draftOf({ ...two, maxConcurrentBuyers: 80, services: [two.services[0]!, { ...two.services[1]!, inputUsdPerMillion: 4 }] })
    const merged = reconcileDraft(edited, base, next)
    expect(merged.maxConcurrentBuyers).toBe('80')
    expect(merged.prices['openai/kimi-k3']!.input).toBe('4')
    expect(patchOf(next, merged)).toEqual({
      displayName: 'Mine',
      pricing: [{ provider: 'openai', service: 'glm-5.3', inputUsdPerMillion: 0.5, outputUsdPerMillion: 3, cachedInputUsdPerMillion: null }],
    })
  })

  it('a price edit keeps the other price fields of that row saved elsewhere', () => {
    const base = draftOf(settings)
    const edited = { ...base, prices: { 'openai/glm-5.3': { ...base.prices['openai/glm-5.3']!, input: '0.5' } } }
    const next = draftOf({ ...settings, services: [{ ...settings.services[0]!, outputUsdPerMillion: 4 }] })
    const merged = reconcileDraft(edited, base, next)
    expect(merged.prices['openai/glm-5.3']).toEqual({ input: '0.5', output: '4', cached: '' })
    expect(patchOf(next, merged).pricing).toEqual([{ provider: 'openai', service: 'glm-5.3', inputUsdPerMillion: 0.5, outputUsdPerMillion: 4, cachedInputUsdPerMillion: null }])
  })

  it('alert drafts rebase the same way', async () => {
    const { rebaseDraft } = await import('./settings')
    const base = { chatId: '1', token: '', clearToken: false, webhookUrl: '', clearWebhook: false, idleMinutes: '30', cooldownMinutes: '30', minSeverity: 'warning' as const }
    const next = { ...base, idleMinutes: '60' }
    const merged = rebaseDraft({ ...base, chatId: '2' }, base, next)
    expect(alertsPatchOf(next, merged)).toEqual({ telegramChatId: '2' })
  })

  it('free tier: a model\'s own program and the seller-wide stakers-only and staked tiers', async () => {
    const { freeTierLine } = await import('../components/SellerSettingsEditor')
    const base = draftOf(settings)
    expect(base.freeTiersMode).toBe('default')
    expect(base.freeTiers).toEqual([{ ants: '10000', multiplier: '5' }])
    const own = { ...base, free: { 'openai/glm-5.3': { enabled: true, perAddress: '100', perIp: '', hours: '', stakersOnly: false } } }
    expect(patchOf(base, own)).toEqual({ pricing: [{ provider: 'openai', service: 'glm-5.3', freeTier: { maxRequestsPerAddress: 100, maxRequestsPerIp: null, windowMs: null, stakersOnly: false } }] })
    const empty = { ...base, free: { 'openai/glm-5.3': { enabled: true, perAddress: '', perIp: '', hours: '', stakersOnly: false } } }
    expect(draftErrors(empty, base)['openai/glm-5.3:freeAddress']).toBeTruthy()
    const wide = { ...base, freePerAddress: '200', freeStakersOnly: true, freeTiersMode: 'custom' as const, freeTiers: [{ ants: '1000', multiplier: '2' }, { ants: '5000', multiplier: 'unlimited' }] }
    expect(draftErrors(wide, base)).toEqual({})
    expect(patchOf(base, wide).freeTier).toEqual({
      maxRequestsPerAddress: 200, maxRequestsPerIp: null, windowMs: null, stakersOnly: true,
      stakeTiers: [{ minPower: 52_000, multiplier: 2 }, { minPower: 260_000, multiplier: 'unlimited' }],
    })
    expect(patchOf(base, { ...base, freeTiersMode: 'off' }).freeTier?.stakeTiers).toEqual([])
    const program = { base: { maxRequestsPerAddress: 100, maxRequestsPerIp: null, windowMs: 86_400_000 }, stakeTiers: [{ minPower: 520_000, multiplier: 5 as const }] }
    expect(freeTierLine(program, true)).toBe('100 free requests a day, then paid · staked: 10,000 ANTS 5×')
    expect(freeTierLine(null, false)).toBe('Free, no limit')
    expect(freeTierLine(null, true)).toBe('No free allowance')
  })

  it('requires prices only on the rows being changed', () => {
    const unpriced = { ...settings, services: [...settings.services, { provider: 'openai', service: 'kimi-k3', inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, inherited: false, paid: true, freeTier: null, ownFreeTier: null }] }
    const base = draftOf(unpriced)
    expect(draftErrors({ ...base, displayName: 'Renamed' }, base)).toEqual({})
    const partial = { ...base, prices: { ...base.prices, 'openai/kimi-k3': { input: '1', output: '', cached: '' } } }
    expect(draftErrors(partial, base)).toEqual({ 'openai/kimi-k3:output': expect.any(String) })
  })

  it('never sends a secret it was not given, and clears on request', () => {
    const base = { chatId: '42', token: '', clearToken: false, webhookUrl: '', clearWebhook: false, idleMinutes: '', cooldownMinutes: '', minSeverity: 'warning' as const }
    expect(alertsPatchOf(base, base)).toEqual({})
    expect(alertsPatchOf(base, { ...base, token: ' 1:abc ', idleMinutes: '30' })).toEqual({ telegramBotToken: '1:abc', idleMinutes: 30 })
    expect(alertsPatchOf(base, { ...base, clearToken: true, clearWebhook: true, chatId: '' })).toEqual({ telegramChatId: null, telegramBotToken: null, webhookUrl: null })
  })
})

describe('market helpers', async () => {
  const { deltaText, offeringKey } = await import('../pages/SellerMarket')

  it('tells apart the same model from two providers', () => {
    const rows = [{ provider: 'openai', service: 'glm-5.3' }, { provider: 'openforge', service: 'glm-5.3' }]
    expect(new Set(rows.map(offeringKey)).size).toBe(2)
    expect(rows.find((row) => offeringKey(row) === 'openforge/glm-5.3')).toBe(rows[1])
  })

  it('words the price delta', () => {
    expect(deltaText(null)).toBe('—')
    expect(deltaText(0.2)).toBe('at median')
    expect(deltaText(-4.25)).toBe('4.3% below')
    expect(deltaText(32)).toBe('32% above')
  })
})

describe('promote claims', async () => {
  const { reconcileClaims } = await import('../pages/SellerPromote')
  const id = (value: string) => value

  it('takes claims saved elsewhere and keeps this editor\'s own additions and removals', () => {
    const base = ['a.example', 'b.example']
    const draft = ['a.example', 'mine.example'] // removed b, added mine
    const next = ['a.example', 'b.example', 'cli.example'] // the CLI added cli
    expect(reconcileClaims(draft, base, next, id)).toEqual(['a.example', 'cli.example', 'mine.example'])
    expect(reconcileClaims(base, base, next, id)).toEqual(next)
    expect(reconcileClaims(['a.example', 'x.example'], base, ['a.example', 'x.example'], id)).toEqual(['a.example', 'x.example'])
  })

  it('keeps a repository edited here when a status check refreshes the saved claim', () => {
    const key = (claim: { username: string; repository: string }) => claim.username.toLowerCase()
    const base = [{ username: 'dev', repository: 'dev' }, { username: 'other', repository: 'other' }]
    const draft = [{ username: 'dev', repository: 'proofs' }, { username: 'other', repository: 'other' }]
    const next = [{ username: 'dev', repository: 'dev' }, { username: 'other', repository: 'other-new' }]
    expect(reconcileClaims(draft, base, next, key)).toEqual([{ username: 'dev', repository: 'proofs' }, { username: 'other', repository: 'other-new' }])
  })
})
