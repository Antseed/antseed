/** Dev mock of a seller on the gateway host (`VITE_MOCK=1`): a running seller with one withdrawn model. */
import type { SellerAlertSettings, SellerAlertsPatch, SellerEventView, SellerFreeTierProgramPatch, SellerFreeTierProgramSettings, SellerMarket, SellerMarketOffer, SellerPromote, SellerReputation, SellerSettings, SellerSettingsPatch, SellerStatus, SellerUsage, SellerVerificationsInput, TelegramChat } from '../api/types'

const DAY = 86_400_000
const FAKE_PEER = '0xfa1e000000000000000000000000000000000007'

export function mockSellerStatus(now = Date.now()): SellerStatus {
  const model = (service: string, advertised: boolean, failures: number, code: number | null, detail: string, ago: number) => (
    { provider: 'openai', providerId: 'openai', service, advertised, consecutiveFailures: failures, lastProbeAt: now - ago, lastStatusCode: code, lastDetail: detail }
  )
  return {
    available: true, running: true, dataDir: '/var/lib/antseed', peerId: FAKE_PEER, provider: 'openai',
    startedAt: now - 13 * 3_600_000, updatedAt: now - 1_000, activeChannels: 9, capacityUsedPercent: 18, notices: [],
    models: [
      model('gemini-2.5-flash', false, 4, 402, 'HTTP 402: You need positive balance to do inference', 150_000),
      model('deepseek-v4.1', true, 0, null, 'Probe passed', 120_000),
      model('glm-5.3', true, 0, null, 'Probe passed', 125_000),
      model('kimi-k3', true, 1, 429, 'HTTP 429: rate limited', 130_000),
    ],
    gas: { address: FAKE_PEER, depleted: false, balanceEth: 0.0297, minBalanceEth: 0.00005, lastCheckedAt: now - 30_000 },
    alerts: null,
    version: '0.0.0-mock',
  }
}

export function mockSellerEvents(now = Date.now()): { events: SellerEventView[] } {
  return {
    events: [
      { at: now - 26 * 60_000, kind: 'model_down', severity: 'warning', title: 'gemini-2.5-flash withdrawn after 3 failed health checks', detail: 'HTTP 402: You need positive balance to do inference' },
      { at: now - 3 * 3_600_000, kind: 'model_up', severity: 'info', title: 'glm-5.3 restored: health check passed' },
      { at: now - 13 * 3_600_000, kind: 'started', severity: 'info', title: 'Seller started' },
    ],
  }
}

export function mockSellerUsage(days: number, now = Date.now()): SellerUsage {
  const today = now - (now % DAY)
  return {
    days: Array.from({ length: days }, (_, index) => {
      const requests = 80 + ((index * 37) % 120)
      return { day: today - (days - 1 - index) * DAY, requests, tokens: requests * 4_000, sessions: Math.ceil(requests / 12), revenueUsd: requests * 0.014 }
    }),
    channels: { active: 9, settled: 412, timeout: 3, ghost: 0, total: 424 },
    deliveredUsdc: 84.21,
    settledUsdc: 79.6,
  }
}

const DEFAULT_TIERS: Array<{ minPower: number; multiplier: number | 'unlimited' }> = [
  { minPower: 520_000, multiplier: 5 }, { minPower: 2_600_000, multiplier: 20 }, { minPower: 10_400_000, multiplier: 'unlimited' },
]

export function mockSellerSettings(): { settings: SellerSettings; alerts: SellerAlertSettings } {
  return {
    settings: {
      configPath: '/var/lib/antseed/config.json', writable: true, readOnlyReason: null, displayName: 'Fake Seller', maxConcurrentBuyers: 50,
      healthCheck: { enabled: true, intervalMs: 300_000, failureThreshold: 3 }, gasCheck: { enabled: true, minBalanceEth: 0.00005 },
      freeTier: { maxRequestsPerAddress: 200, maxRequestsPerIp: 400, windowMs: null, stakersOnly: false, stakeTiers: null }, restrictedCountries: ['CU', 'IR', 'KP', 'SY', 'RU'], restrictedCountriesDefault: true,
      defaultStakeTiers: DEFAULT_TIERS,
      services: [
        { provider: 'openai', service: 'glm-5.3', inputUsdPerMillion: 0.8, outputUsdPerMillion: 2.4, cachedInputUsdPerMillion: 0.1, inherited: false, paid: true,
          freeTier: { base: { maxRequestsPerAddress: 100, maxRequestsPerIp: null, windowMs: 86_400_000 }, stakeTiers: DEFAULT_TIERS },
          ownFreeTier: { maxRequestsPerAddress: 100, maxRequestsPerIp: null, windowMs: null, stakersOnly: false, stakeTiers: null } },
        { provider: 'openai', service: 'kimi-k3', inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5, cachedInputUsdPerMillion: null, inherited: true, paid: true, freeTier: null, ownFreeTier: null },
        { provider: 'openai', service: 'qwen-3.6-27b', inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: null, inherited: false, paid: false,
          freeTier: { base: { maxRequestsPerAddress: 200, maxRequestsPerIp: 400, windowMs: 86_400_000 }, stakeTiers: DEFAULT_TIERS }, ownFreeTier: null },
      ],
    },
    alerts: {
      writable: true, readOnlyReason: null,
      telegram: { chatId: null, botTokenEnv: 'ANTSEED_ALERTS_TELEGRAM_TOKEN', tokenSet: false, tokenSource: null, active: false },
      webhook: { set: false, host: null, source: null }, idleMinutes: null, cooldownMinutes: null, lowBalanceUsd: null, minSeverity: null,
    },
  }
}

const network = (now: number) => ({ source: 'gateway buyer', refreshedAt: now - 4 * 60_000, refreshing: false, error: null, peers: 8 })
const offer = (n: number, name: string, input: number, output: number, trust: number, extra: Partial<SellerMarketOffer> = {}): SellerMarketOffer => ({
  peerId: `fa1e${String(n).padStart(36, '0')}`, name, mine: false, inputUsdPerMillion: input, outputUsdPerMillion: output, cachedInputUsdPerMillion: null,
  blendedUsdPerMillion: (3 * input + output) / 4, trustScore: trust, tee: false, load: 0.3, ...extra,
})

export function mockSellerMarket(now = Date.now()): SellerMarket {
  const mine = offer(0, 'Fake Seller', 0.8, 2.4, 47.7, { mine: true, peerId: FAKE_PEER.slice(2) })
  const glm = [offer(1, 'Fake Seller Alpha', 0.6, 2.2, 84, { tee: true }), offer(7, 'Fake Seller Eta', 0.7, 2.3, 49), mine, offer(2, 'Fake Seller Beta', 0.75, 2.5, 69), offer(5, 'Fake Seller Epsilon', 0.82, 2.6, 12), offer(3, 'Fake Seller Gamma', 0.95, 3.1, 26)]
  return {
    network: network(now), found: true,
    services: [
      { provider: 'openai', service: 'glm-5.3', mine: { inputUsdPerMillion: 0.8, outputUsdPerMillion: 2.4, cachedInputUsdPerMillion: 0.1, blendedUsdPerMillion: 1.2 }, competitors: 5, unique: false,
        cheapest: { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }, median: { inputUsdPerMillion: 0.75, outputUsdPerMillion: 2.5 }, rank: 3, of: 6, deltaPct: 1.1, offers: glm },
      { provider: 'openai', service: 'kimi-k3', mine: { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5, cachedInputUsdPerMillion: null, blendedUsdPerMillion: 1.075 }, competitors: 2, unique: false,
        cheapest: { inputUsdPerMillion: 0.55, outputUsdPerMillion: 2.4 }, median: { inputUsdPerMillion: 0.585, outputUsdPerMillion: 2.5 }, rank: 2, of: 3, deltaPct: 1.8,
        offers: [offer(2, 'Fake Seller Beta', 0.55, 2.4, 69), { ...mine, inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5, blendedUsdPerMillion: 1.075 }, offer(5, 'Fake Seller Epsilon', 0.62, 2.6, 12)] },
    ],
    notOffered: [{ service: 'deepseek-v4.1', sellers: 3, cheapestOutputUsdPerMillion: 1.05 }, { service: 'qwen3-coder-480b-turbo', sellers: 3, cheapestOutputUsdPerMillion: 2.9 }, { service: 'gemma-4-e4b', sellers: 2, cheapestOutputUsdPerMillion: 0 }],
  }
}

export function mockSellerReputation(now = Date.now()): SellerReputation {
  return {
    network: network(now), found: true,
    trust: {
      score: 47.7, history: { score: 31.2, max: 50, channelCount: 125, volumeUsdc: 74.88 }, usage: { score: 8.4, max: 20, shareBps: 756, epoch: 27 },
      power: { score: 3.1, max: 10, shareBps: 372, epoch: 28 }, identity: null, freeModels: { score: 5, max: 5, service: 'gemma-4-e4b' }, washFlagged: false,
    },
    rank: { position: 6, of: 8 },
    steps: [
      { part: 'identity', text: 'Verify a domain or a GitHub account under Promote. Up to 20 points, more for an older domain or a GitHub account with real history.' },
      { part: 'history', text: 'Settle more paid sessions: history counts settled channels (full at 100) and settled volume (full at $100). Now 125 channels, $74.88.' },
      { part: 'usage', text: "Grow recognized usage: your pool's share of last week's usage points. Points need a seller pool and come from real paid traffic." },
    ],
    standing: { address: FAKE_PEER, agentId: 412, identityRegistered: true, registryBound: true, eligible: true, minPoolStake: '1000', poolActiveStake: '18250',
      pool: { powerShareBps: 372, stakers: 14, uniqueBuyers: 37, requestCount: '48211', lifetimeVolumeUsdc: '74.88', ghostRate: 1.6, lastEpochEmission: '930.5' }, pendingRewards: '212.4' },
    standingError: null, standingRefreshedAt: now - 6 * 60_000,
  }
}

export function mockSellerPromote(now = Date.now()): SellerPromote {
  return promoteStore ??= initialPromote(now)
}

function initialPromote(now: number): SellerPromote {
  const peer = FAKE_PEER.slice(2)
  return {
    peerId: peer, displayName: 'Fake Seller', profileUrl: `https://explorer.example/account/${FAKE_PEER}`, trustScore: 47.7, pending: false, writable: true, readOnlyReason: null,
    services: [
      { provider: 'openai', service: 'glm-5.3', inputUsdPerMillion: 0.8, outputUsdPerMillion: 2.4 },
      { provider: 'openai', service: 'kimi-k3', inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5 },
      { provider: 'openai', service: 'gemma-4-e4b', inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    ],
    domains: [{ domain: 'seller.example', txtName: '_antseed.seller.example', txtValue: `antseed-peer=${peer}`, wellKnownUrl: 'https://seller.example/.well-known/antseed.json',
      wellKnownBody: JSON.stringify({ type: 'antseed-domain-verification', peerId: peer, domain: 'seller.example' }, null, 2), status: { verified: false, checkedAt: now - 60_000, error: 'dns-txt: no matching proof; https-well-known: HTTP 404' } }],
    github: [],
  }
}

export function mockSellerLogs(query: URLSearchParams, now = Date.now()) {
  const all = mockSellerLogRows(now)
    .filter((row) => (!query.get('service') || row.service === query.get('service')) && (!query.get('errors') || row.statusCode >= 400))
  const start = Number(query.get('cursor') ?? 0)
  const limit = Number(query.get('limit') ?? 50)
  return { entries: all.slice(start, start + limit), next: start + limit < all.length ? String(start + limit) : null }
}

/** One mock request with its receipt, session and channel; paid ones carry a receipt and a channel. */
export function mockSellerLogDetail(id: string, now = Date.now()) {
  const row = mockSellerLogRows(now).find((entry) => entry.id === id)
  if (!row) return null
  const paid = row.costUsd !== null
  return {
    ...row,
    tokenConfidence: row.exactTokens ? 'high' : 'low',
    receipt: paid ? { id: `rcpt-${row.id}`, usdPerMillionTokens: 4.2, buyerCheck: { signatureValid: true, buyerTokens: row.inputTokens + row.outputTokens + 3, differencePercent: 0.2, disputed: false } } : null,
    session: { id: row.sessionId, position: 4, startedAt: row.at - 300_000, endedAt: null, requests: 12, tokens: 48_210, costUsd: 0.42, avgLatencyMs: 1_240 },
    channel: paid ? { id: `0x${'c4a1'.repeat(16)}`, oneOff: false, status: 'active', openedAt: row.at - 900_000, settledAt: null, authorizedUsd: 5, deliveredUsd: 1.37, settledUsd: null, requests: 58 } : null,
  }
}

function mockSellerLogRows(now: number) {
  const models = ['glm-5.3', 'kimi-k3', 'glm-5.3', 'gemma-4-e4b', 'glm-5.3', 'kimi-k3']
  return Array.from({ length: 120 }, (_, index) => {
    const failed = index % 17 === 5
    return {
      id: `evt-${index}`, at: now - index * 47_000, buyer: `fa1e${String(1 + (index % 4)).padStart(36, '0')}`, sessionId: `s${index % 9}`,
      service: index > 100 ? null : models[index % models.length]!, provider: 'openai', inputTokens: failed ? 0 : 900 + (index * 37) % 4000, outputTokens: failed ? 0 : 120 + (index * 13) % 900,
      exactTokens: index % 11 !== 3, costUsd: failed || models[index % models.length] === 'gemma-4-e4b' ? null : 0.01 * (1 + (index % 4)), latencyMs: 400 + (index * 97) % 3_000,
      statusCode: failed ? (index % 2 ? 402 : 502) : 200, streaming: true,
      error: failed ? (index % 2 ? 'Payment required: the buyer has no open channel' : 'upstream connect error: connection reset') : null,
      cachedInputTokens: failed || index % 3 ? null : 640,
    }
  })
}

// ── Writes: the mock keeps its seller settings and claims in memory until reload ──

let settingsStore: ReturnType<typeof mockSellerSettings> | null = null
let promoteStore: SellerPromote | null = null

/** The settings as the mock seller has them now (edits included). */
export function mockSellerSettingsState() {
  return settingsStore ??= mockSellerSettings()
}

/** A free-tier program's edit, field by field, like the seller's settings writer. */
function patchProgram(current: SellerFreeTierProgramSettings, input: SellerFreeTierProgramPatch): SellerFreeTierProgramSettings {
  const next = { ...current }
  if (input.maxRequestsPerAddress !== undefined) next.maxRequestsPerAddress = input.maxRequestsPerAddress
  if (input.maxRequestsPerIp !== undefined) next.maxRequestsPerIp = input.maxRequestsPerIp
  if (input.windowMs !== undefined) next.windowMs = input.windowMs
  if (input.stakersOnly !== undefined) next.stakersOnly = input.stakersOnly
  if (input.stakeTiers !== undefined) next.stakeTiers = input.stakeTiers
  return next
}

const EMPTY_PROGRAM: SellerFreeTierProgramSettings = { maxRequestsPerAddress: null, maxRequestsPerIp: null, windowMs: null, stakersOnly: false, stakeTiers: null }

export function mockUpdateSellerSettings(patch: SellerSettingsPatch) {
  const state = mockSellerSettingsState()
  const settings = structuredClone(state.settings)
  const changed = Object.keys(patch)
  if (patch.displayName !== undefined) settings.displayName = patch.displayName
  if (patch.maxConcurrentBuyers !== undefined) settings.maxConcurrentBuyers = patch.maxConcurrentBuyers
  if (patch.healthCheck) settings.healthCheck = { ...settings.healthCheck, ...patch.healthCheck }
  if (patch.gasCheck) settings.gasCheck = { ...settings.gasCheck, ...patch.gasCheck }
  if (patch.freeTier) {
    const program = patchProgram(settings.freeTier, patch.freeTier)
    // Clearing both limits removes the seller-wide program.
    settings.freeTier = program.maxRequestsPerAddress === null && program.maxRequestsPerIp === null ? EMPTY_PROGRAM : program
  }
  if (patch.restrictedCountries !== undefined) {
    settings.restrictedCountries = patch.restrictedCountries ?? []
    settings.restrictedCountriesDefault = patch.restrictedCountries === null
  }
  for (const entry of patch.pricing ?? []) {
    const service = settings.services.find((row) => row.provider === entry.provider && row.service === entry.service)
    if (!service) throw new Error(`pricing: no service ${entry.service} under provider ${entry.provider} in the config file`)
    if (entry.inputUsdPerMillion !== undefined) service.inputUsdPerMillion = entry.inputUsdPerMillion
    if (entry.outputUsdPerMillion !== undefined) service.outputUsdPerMillion = entry.outputUsdPerMillion
    if (entry.cachedInputUsdPerMillion !== undefined) service.cachedInputUsdPerMillion = entry.cachedInputUsdPerMillion
    if (entry.inputUsdPerMillion !== undefined || entry.outputUsdPerMillion !== undefined) service.inherited = false
    if (entry.freeTier === null) service.ownFreeTier = null
    else if (entry.freeTier) service.ownFreeTier = patchProgram(service.ownFreeTier ?? EMPTY_PROGRAM, entry.freeTier)
    const own = service.ownFreeTier
    service.freeTier = own ? { base: { maxRequestsPerAddress: own.maxRequestsPerAddress, maxRequestsPerIp: own.maxRequestsPerIp, windowMs: own.windowMs ?? 86_400_000 }, stakeTiers: own.stakeTiers ?? DEFAULT_TIERS } : service.paid ? null : service.freeTier
  }
  settingsStore = { ...state, settings }
  return { ...settingsStore, changed }
}

export function mockUpdateSellerAlerts(patch: SellerAlertsPatch) {
  const state = mockSellerSettingsState()
  const alerts: SellerAlertSettings = structuredClone(state.alerts)
  if (patch.telegramChatId !== undefined) alerts.telegram.chatId = patch.telegramChatId
  if (patch.telegramBotToken !== undefined) {
    alerts.telegram.tokenSet = patch.telegramBotToken !== null
    alerts.telegram.tokenSource = patch.telegramBotToken === null ? null : 'file'
  }
  alerts.telegram.active = alerts.telegram.tokenSet && Boolean(alerts.telegram.chatId)
  if (patch.webhookUrl !== undefined) {
    alerts.webhook = patch.webhookUrl === null
      ? { set: false, host: null, source: null }
      : { set: true, host: new URL(patch.webhookUrl).host, source: 'file' }
  }
  if (patch.idleMinutes !== undefined) alerts.idleMinutes = patch.idleMinutes
  if (patch.cooldownMinutes !== undefined) alerts.cooldownMinutes = patch.cooldownMinutes
  if (patch.lowBalanceUsd !== undefined) alerts.lowBalanceUsd = patch.lowBalanceUsd
  if (patch.minSeverity !== undefined) alerts.minSeverity = patch.minSeverity
  settingsStore = { ...state, alerts }
  return { ...settingsStore, changed: Object.keys(patch) }
}

export function mockTestAlert(channel: 'telegram' | 'webhook'): { sent: string[]; errors: string[] } {
  const { alerts } = mockSellerSettingsState()
  const ready = channel === 'telegram' ? alerts.telegram.active : alerts.webhook.set
  return ready ? { sent: [channel], errors: [] } : { sent: [], errors: [`${channel}: Save the ${channel === 'telegram' ? 'bot token and chat id' : 'webhook URL'} first`] }
}

export function mockTelegramChats(): { chats: TelegramChat[] } {
  return { chats: [{ id: '-1001234567890', title: 'Seller alerts', type: 'supergroup' }, { id: '42424242', title: 'Dana Owner', type: 'private' }] }
}

export function mockCheckVerifications(now = Date.now()): SellerPromote {
  const promote = mockSellerPromote(now)
  promoteStore = {
    ...promote,
    domains: promote.domains.map((claim) => ({ ...claim, status: { verified: false, checkedAt: now, error: 'dns-txt: no matching proof; https-well-known: HTTP 404' } })),
    github: promote.github.map((claim) => ({ ...claim, status: { verified: false, checkedAt: now, error: 'github: HTTP 404' } })),
  }
  return promoteStore
}

export function mockSaveVerifications(input: SellerVerificationsInput, now = Date.now()): SellerPromote {
  const promote = mockSellerPromote(now)
  const peer = promote.peerId ?? ''
  promoteStore = {
    ...promote,
    domains: input.domains.map(({ domain }) => promote.domains.find((claim) => claim.domain === domain) ?? {
      domain, txtName: `_antseed.${domain}`, txtValue: `antseed-peer=${peer}`, wellKnownUrl: `https://${domain}/.well-known/antseed.json`,
      wellKnownBody: JSON.stringify({ type: 'antseed-domain-verification', peerId: peer, domain }, null, 2), status: null,
    }),
    github: input.github.map(({ username, repository }) => {
      const repo = repository ?? username
      const existing = promote.github.find((claim) => claim.username.toLowerCase() === username.toLowerCase() && claim.repository === repo)
      return existing ?? {
        username, repository: repo, proofUrl: `https://raw.githubusercontent.com/${username}/${repo}/HEAD/antseed.json`,
        proofBody: JSON.stringify({ type: 'antseed-github-verification', peerId: peer, username }, null, 2), status: null,
      }
    }),
  }
  return promoteStore
}
