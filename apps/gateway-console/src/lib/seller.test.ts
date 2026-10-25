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
        { provider: 'openai', service: 'glm-5.3', advertised: false, consecutiveFailures: 4, lastProbeAt: now, lastStatusCode: 402, lastDetail: 'HTTP 402' },
        { provider: 'openai', service: 'kimi-k3', advertised: true, consecutiveFailures: 0, lastProbeAt: now, lastStatusCode: null, lastDetail: null },
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
    expect(lastResult({ provider: 'p', service: 's', advertised: false, consecutiveFailures: 1, lastProbeAt: 1, lastStatusCode: 402, lastDetail: 'out of credit' })).toBe('HTTP 402 · out of credit')
    expect(lastResult({ provider: 'p', service: 's', advertised: false, consecutiveFailures: 1, lastProbeAt: 1, lastStatusCode: 402, lastDetail: 'HTTP 402: no balance' })).toBe('HTTP 402: no balance')
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
  const { draftOf, draftErrors, patchOf } = await import('../components/SellerSettingsEditor')
  const { alertsPatchOf } = await import('../components/SellerAlertsEditor')
  const settings = {
    configPath: '/c', writable: true, readOnlyReason: null, displayName: 'S', maxConcurrentBuyers: 50,
    healthCheck: { enabled: true, intervalMs: 300_000, failureThreshold: 3 }, gasCheck: { enabled: true, minBalanceEth: 0.00005 },
    freeTier: { maxRequestsPerAddress: null, maxRequestsPerIp: null, windowMs: null }, restrictedCountries: ['RU'], restrictedCountriesDefault: true,
    services: [{ provider: 'openai', service: 'glm-5.3', inputUsdPerMillion: 1, outputUsdPerMillion: 3, cachedInputUsdPerMillion: null, inherited: false }],
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

  it('never sends a secret it was not given, and clears on request', () => {
    const base = { chatId: '42', token: '', clearToken: false, webhookUrl: '', clearWebhook: false, idleMinutes: '', cooldownMinutes: '', minSeverity: 'warning' as const }
    expect(alertsPatchOf(base, base)).toEqual({})
    expect(alertsPatchOf(base, { ...base, token: ' 1:abc ', idleMinutes: '30' })).toEqual({ telegramBotToken: '1:abc', idleMinutes: 30 })
    expect(alertsPatchOf(base, { ...base, clearToken: true, clearWebhook: true, chatId: '' })).toEqual({ telegramChatId: null, telegramBotToken: null, webhookUrl: null })
  })
})

describe('market helpers', async () => {
  const { deltaText } = await import('../pages/SellerMarket')

  it('words the price delta', () => {
    expect(deltaText(null)).toBe('—')
    expect(deltaText(0.2)).toBe('at median')
    expect(deltaText(-4.25)).toBe('4.3% below')
    expect(deltaText(32)).toBe('32% above')
  })
})
