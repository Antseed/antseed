import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MeteringStorage } from '@antseed/node/metering'

/** One metered request: an event, its receipt and (once per session) the session row. Test and demo data only. */
export interface FixtureRequest {
  at: number
  sessionId: string
  tokens: number
  costCents: number
  service?: string
  statusCode?: number
  /** Defaults to one of four obvious fake buyers (fa1e…). */
  buyer?: string
}

/** Writes a seller data dir: daemon state, an event journal and a metering DB. */
export function writeSellerFixture(dataDir: string, input: { state?: Record<string, unknown>; events?: unknown[]; requests?: FixtureRequest[] }): void {
  mkdirSync(dataDir, { recursive: true })
  if (input.state) writeFileSync(join(dataDir, 'daemon.state.json'), JSON.stringify(input.state))
  if (input.events) writeFileSync(join(dataDir, 'seller-events.jsonl'), input.events.map((event) => JSON.stringify(event)).join('\n') + '\n')
  if (!input.requests) return
  const metering = new MeteringStorage(join(dataDir, 'metering.db'))
  const sessions = new Set<string>()
  try {
    input.requests.forEach((request, index) => {
      const id = `${request.sessionId}-${request.at}-${index}`
      const tokens = { inputTokens: Math.round(request.tokens * 0.7), outputTokens: request.tokens - Math.round(request.tokens * 0.7), totalTokens: request.tokens, method: 'provider-usage' as const, confidence: 'high' as const }
      const common = { sessionId: request.sessionId, timestamp: request.at, provider: 'openai', sellerPeerId: 'seller', buyerPeerId: request.buyer ?? `fa1e${String(1 + (index % 4)).padStart(36, '0')}`, tokens }
      metering.insertEvent({ ...common, eventId: `event-${id}`, latencyMs: 400 + (index * 97) % 2_600, statusCode: request.statusCode ?? 200, wasStreaming: true, ...(request.service ? { service: request.service } : {}) })
      if ((request.statusCode ?? 200) < 400 && request.costCents > 0) metering.insertReceipt({ ...common, receiptId: `receipt-${id}`, eventId: `event-${id}`, unitPriceCentsPerThousandTokens: 0, costCents: request.costCents, signature: '' })
      if (!sessions.has(request.sessionId)) {
        sessions.add(request.sessionId)
        metering.upsertSession({ sessionId: request.sessionId, sellerPeerId: 'seller', buyerPeerId: 'buyer', provider: 'openai', startedAt: request.at, endedAt: null, totalRequests: 1, totalTokens: request.tokens, totalCostCents: request.costCents, avgLatencyMs: 400, peerSwitches: 0, disputedReceipts: 0 })
      }
    })
  } finally {
    metering.close()
  }
}

/** A fake network around `myPeerId` for tests and screenshots: obvious fake ids (0xfa1e…), realistic prices and trust parts. */
export function fakeNetworkRows(myPeerId: string, myServices: Record<string, [number, number]>): Array<Record<string, unknown>> {
  const peer = (n: number) => `fa1e${String(n).padStart(36, '0')}`
  const trust = (history: number, usage: number, power: number, identity: number, free: boolean) => ({
    score: Math.min(100, history + usage + power + identity + (free ? 5 : 0)),
    history: { score: history, channelCount: Math.round(history * 4), totalVolumeUsdcMicros: Math.round(history * 2_400_000) },
    usage: usage ? { score: usage, shareBps: Math.round(usage * 90), epoch: 27 } : null,
    power: power ? { score: power, shareBps: Math.round(power * 120), epoch: 28 } : null,
    identity: identity ? { score: identity, kind: 'domain', claim: 'example.com' } : null,
    freeModels: free ? { score: 5, service: 'gemma-4-e4b' } : null,
    washFlagged: false,
  })
  const seller = (n: number, name: string, services: Record<string, [number, number, number?]>, parts: Parameters<typeof trust>, extra: Record<string, unknown> = {}) => ({
    peerId: peer(n), displayName: name, providers: ['openai'], capabilities: [],
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 3 }, services: Object.fromEntries(Object.entries(services).map(([id, [input, output, cached]]) => [id, { inputUsdPerMillion: input, outputUsdPerMillion: output, ...(cached !== undefined ? { cachedInputUsdPerMillion: cached } : {}) }])) } },
    trust: trust(...parts), onChainReputationScore: trust(...parts).score, maxConcurrency: 100, currentLoad: Math.round(n * 7 % 90), lastSeen: Date.now(), ...extra,
  })
  const myTrust = trust(31.2, 8.4, 3.1, 0, true)
  return [
    {
      peerId: myPeerId.replace(/^0x/, ''), displayName: 'Demo Seller', providers: ['openai'], capabilities: [],
      providerPricing: { openai: { defaults: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 2 }, services: Object.fromEntries(Object.entries(myServices).map(([id, [input, output]]) => [id, { inputUsdPerMillion: input, outputUsdPerMillion: output }])) } },
      trust: myTrust, onChainReputationScore: myTrust.score, maxConcurrency: 500, currentLoad: 61, lastSeen: Date.now(),
    },
    seller(1, 'Fake Seller Alpha', { 'glm-5.3': [0.6, 2.2, 0.11], 'deepseek-v4.1': [0.27, 1.1], 'qwen3-coder-480b-turbo': [0.9, 2.9] }, [44, 14, 6, 20, false], { capabilities: ['verifier.antseed-verifier'] }),
    seller(2, 'Fake Seller Beta', { 'glm-5.3': [0.75, 2.5], 'kimi-k3': [0.55, 2.4], 'gemma-4-e4b': [0, 0] }, [38, 10, 4, 12, true]),
    seller(3, 'Fake Seller Gamma', { 'glm-5.3': [0.95, 3.1], 'deepseek-v4.1': [0.32, 1.3], 'minimax-m3': [0.4, 1.6] }, [22, 3, 1, 0, false]),
    seller(4, 'Fake Seller Delta', { 'deepseek-v4.1': [0.25, 1.05], 'qwen3-coder-480b-turbo': [1.1, 3.4] }, [47, 18, 9, 16, false], { capabilities: ['verifier.antseed-verifier'] }),
    seller(5, 'Fake Seller Epsilon', { 'glm-5.3': [0.82, 2.6], 'kimi-k3': [0.62, 2.6], 'minimax-m3': [0.38, 1.5] }, [12, 0, 0, 0, false]),
    seller(6, 'Fake Seller Zeta', { 'qwen3-coder-480b-turbo': [0.85, 3.0], 'gemma-4-e4b': [0, 0], 'llama-4-maverick': [0.2, 0.6] }, [29, 6, 2, 8, true]),
    seller(7, 'Fake Seller Eta', { 'glm-5.3': [0.7, 2.3], 'llama-4-maverick': [0.18, 0.55] }, [35, 9, 5, 0, false]),
  ]
}
