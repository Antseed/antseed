import type {
  AdminToken, ApiKey, AuditEntry, AuthConfig, Channel, ChainInfo, Invite, Member, NetworkModel, NetworkModelOffer, NetworkRouter, Peer, PeerList, Preset, RequestDetail, RoutingPolicy, Settings, Workspace, WorkspaceRole, RouteSelection, ServedSelection,
} from '../api/types'

/** Obvious fake peer ids for the mock: 0xfa1e…0001 etc. */

/** What the fake buyer reports of its seller at `rank` (1-based) among `of`: the top two share traffic, the fourth fails lately. */
export function mockRouteSelection(rank: number, of: number, seed: number, now = Date.now()): RouteSelection {
  const pool = Math.min(2, of)
  const failing = rank === 4
  const success = failing ? 0.38 : [0.97, 0.93, 0.88][rank - 1] ?? 0.8
  const fresh = rank === 3 && seed % 2 === 0
  return {
    expectedCostUsd: (0.0011 + rank * 0.0004) / success,
    expectedPriceUsd: 0.0011 + rank * 0.0004,
    expectedSeconds: 2.4 + rank * 0.6,
    successRate: fresh ? 0.8 : success,
    observations: fresh ? 0 : Math.max(1, 34 - rank * 7 + (seed % 5)),
    record: fresh ? 'none' : rank === 3 ? 'other-models' : 'model',
    firstTokenMs: fresh ? null : 280 + rank * 140,
    tokensPerSecond: fresh ? null : 92 - rank * 14,
    lastSuccessAt: fresh ? null : now - rank * 40_000,
    lastFailureAt: failing ? now - 3 * 60_000 : rank === 2 ? now - 25 * 60_000 : null,
    lastFailureReason: failing ? 'seller 503' : rank === 2 ? 'timeout before first token' : null,
    failing,
    coolingDown: false,
    stale: fresh,
    ordering: 'expected-cost',
    sharesTraffic: rank <= pool && pool > 1,
    trafficShare: rank <= pool && pool > 1 ? (rank === 1 ? 0.62 : 0.38) : null,
    poolSize: pool,
    channel: rank === 3 ? 'new' : 'open',
    inFlight: rank === 1 ? 2 : 0,
    maxConcurrency: 8,
    routeChainPosition: null,
  }
}

const PICKS: Array<ServedSelection['pick']> = ['spread', 'spread', 'conversation', 'spread', 'failover', 'spread', 'exploration', 'spread']

function servedSelection(index: number, now: number): ServedSelection {
  const pick = PICKS[index % PICKS.length]!
  const rank = pick === 'failover' ? 2 : pick === 'exploration' ? 3 : index % 3 === 0 ? 2 : 1
  return { ...mockRouteSelection(rank, 4, index, now), rank, of: 4, attempt: pick === 'failover' ? 1 : 0, pick }
}

export const fakePeerId = (index: number) => `0xfa1e${'0'.repeat(32)}${String(index).padStart(4, '0')}`
export const fakeAddress = (index: number) => `0x${'00'.repeat(18)}${String(index).padStart(4, '0')}`

const DAY = 86_400_000
const now = Date.now()
const limits = (monthly: string | null = null, daily: string | null = null) => ({ daily, weekly: null, monthly, total: null })

export function seed() {
  const members: Member[] = [
    { id: 'mem_owner', label: 'Dana Owner', email: 'dana@example.com', orgRole: 'owner', status: 'active', credentials: [{ id: 'cred_1', kind: 'passkey', label: 'MacBook Touch ID', createdAt: now - 40 * DAY, lastUsedAt: now - 3600_000 }, { id: 'cred_3', kind: 'wallet', label: fakeAddress(8), createdAt: now - 39 * DAY, lastUsedAt: now - 5 * DAY }, { id: 'cred_4', kind: 'wallet', label: fakeAddress(10), createdAt: now - 3 * 3600_000, lastUsedAt: null }], limits: limits(), routingPolicy: null, maxKeys: null, createdAt: now - 40 * DAY },
    { id: 'mem_ali', label: 'Ali Admin', email: 'ali@example.com', orgRole: 'admin', status: 'active', credentials: [{ id: 'cred_2', kind: 'wallet', label: fakeAddress(9), createdAt: now - 20 * DAY, lastUsedAt: now - DAY }], limits: limits('500.000000'), routingPolicy: null, maxKeys: 10, createdAt: now - 20 * DAY },
    { id: 'mem_sam', label: 'Sam Member', email: 'sam@example.com', orgRole: 'member', status: 'active', credentials: [], limits: limits('50.000000', '5.000000'), routingPolicy: { requireVerified: true }, maxKeys: 3, createdAt: now - 7 * DAY },
    { id: 'mem_wade', label: 'Wade Workspace-Admin', email: 'wade@example.com', orgRole: 'member', status: 'active', credentials: [], limits: limits(), routingPolicy: null, maxKeys: 5, createdAt: now - 6 * DAY },
    { id: 'mem_robin', label: 'Robin Contractor', email: null, orgRole: 'member', status: 'invited', credentials: [], limits: limits(), routingPolicy: null, maxKeys: 2, createdAt: now - DAY },
  ]
  const workspaces: Workspace[] = [
    { id: 'ws_default', name: 'Default', isDefault: true, buyerIdentity: 'default', walletAddress: fakeAddress(1), limits: limits('1000.000000', '80.000000'), routingPolicy: null, orgRoutingPolicy: { blockedPeerIds: [fakePeerId(5)] }, memberCount: 3, keyCount: 3, createdAt: now - 40 * DAY },
    { id: 'ws_research', name: 'Research', isDefault: false, buyerIdentity: 'research', walletAddress: fakeAddress(2), limits: limits('200.000000'), routingPolicy: { sort: 'price', preferFreePeers: true }, orgRoutingPolicy: null, memberCount: 2, keyCount: 1, createdAt: now - 10 * DAY },
  ]
  const workspaceMembers: Record<string, Record<string, WorkspaceRole>> = {
    ws_default: { mem_owner: 'admin', mem_ali: 'admin', mem_sam: 'member', mem_wade: 'admin', mem_robin: 'member' },
    ws_research: { mem_owner: 'admin', mem_sam: 'admin' },
  }
  const key = (id: string, label: string, workspaceId: string, owner: string, spent: string, extra: Partial<ApiKey> = {}): ApiKey => ({
    id, label, hint: `antseed_…${id.slice(-4)}`, workspaceId, ownerMemberId: owner, buyerIdentity: workspaceId === 'ws_default' ? 'default' : 'research',
    status: 'active', limits: limits(), routingPolicy: null, ownerLimits: limits(), ownerRoutingPolicy: null, topupEnabled: false, expiresAt: null, createdAt: now - 9 * DAY, lastUsedAt: now - 120_000,
    usage: { requests: 1820, spent, spentThisMonth: spent }, ...extra,
  })
  const keys: ApiKey[] = [
    key('key_prod', 'Production backend', 'ws_default', 'mem_owner', '142.512300', { limits: limits('400.000000') }),
    key('key_ci', 'CI evals', 'ws_default', 'mem_ali', '18.200000', { routingPolicy: { sort: 'price', maxInputUsdPerMillion: 1 } }),
    // Admin layer allows two sellers; Sam narrowed it further with his own cap.
    key('key_sam', 'Sam laptop', 'ws_default', 'mem_sam', '3.041000', { expiresAt: now + 20 * DAY, limits: limits(null, '2.000000'), routingPolicy: { allowedPeerIds: [fakePeerId(1), fakePeerId(2)] }, ownerLimits: limits(null, '1.000000'), ownerRoutingPolicy: { maxInputUsdPerMillion: 2 } }),
    key('key_lab', 'Notebook', 'ws_research', 'mem_sam', '9.900000', { topupEnabled: true }),
  ]
  const models = ['deepseek-v3.1', 'qwen3-coder-480b', 'llama-3.3-70b', 'kimi-k2', 'gpt-oss-120b']
  // One seller with many models (a few over the Anthropic messages API), for the seller page.
  const manyModels = [
    'deepseek-v3.1', 'deepseek-r1', 'qwen3-coder-480b', 'qwen3-235b-a22b', 'qwen3-32b', 'qwen2.5-vl-72b', 'llama-3.3-70b', 'llama-4-maverick',
    'llama-4-scout', 'kimi-k2', 'kimi-k2-thinking', 'gpt-oss-120b', 'gpt-oss-20b', 'glm-4.6', 'glm-4.5-air', 'mistral-large-2411',
    'mistral-small-3.2', 'gemma-3-27b', 'phi-4', 'minimax-m2', 'hermes-4-405b', 'nemotron-70b', 'olmo-2-32b', 'command-a',
  ]
  const manyServices = manyModels.map((service, m) => {
    const base = 0.1 + ((m * 5) % 12) / 5
    return {
      provider: m >= 20 ? 'anthropic' : 'openai', service, categories: ['chat'],
      inputUsdPerMillion: Number(base.toFixed(2)), outputUsdPerMillion: Number((base * 3.5).toFixed(2)), cachedInputUsdPerMillion: m % 4 === 0 ? null : Number((base / 5).toFixed(3)),
    }
  })
  const names = ['Fake Seller Alpha', 'Fake Seller Beta', 'Fake TEE Gamma', 'Fake Free Delta', 'Fake Seller Epsilon', null, 'Fake Seller Eta', 'Fake Seller Theta']
  const peers: Peer[] = names.map((displayName, index) => ({
    peerId: fakePeerId(index + 1),
    displayName,
    services: index === 2 ? manyServices : models.filter((_, m) => (m + index) % 3 !== 0).map((service, m) => {
      const free = index === 3
      const base = 0.2 + ((index * 7 + m * 3) % 10) / 4
      return { provider: 'openai', service, inputUsdPerMillion: free ? 0 : Number(base.toFixed(2)), outputUsdPerMillion: free ? 0 : Number((base * 3).toFixed(2)), cachedInputUsdPerMillion: free ? 0 : Number((base / 4).toFixed(3)), categories: ['chat'], paid: !free }
    }),
    trustScore: [92, 78, 88, 41, 65, null, 55, 83][index]!,
    reputationScore: [90, 74, 85, 50, 60, null, 52, 80][index]!,
    verified: index === 2 || index === 0,
    // Obvious fake identities on example domains.
    verificationLinks: index === 0
      ? [{ kind: 'domain' as const, label: 'alpha.example.com', href: 'https://alpha.example.com' }, { kind: 'github' as const, label: '@fake-alpha', href: 'https://github.com/fake-alpha' }]
      : index === 2 ? [{ kind: 'github' as const, label: '@fake-gamma/tee-node', href: 'https://github.com/fake-gamma/tee-node' }] : [],
    tee: index === 2 || index === 1 || index === 4,
    // Gamma is attested end to end, Beta at the seller node only, Epsilon not checked yet.
    teeScope: index === 2 ? 'end-to-end' as const : index === 1 ? 'seller-node' as const : null,
    stakeAnts: index < 5 ? `${(index + 1) * 2500}.0` : null,
    agentId: 86_900 + index,
    // Delta's free models come with the default staked tiers.
    freeTier: index === 3 ? {
      base: { maxRequestsPerAddress: 1000, maxRequestsPerIp: null, windowMs: 86_400_000 },
      stakeTiers: [{ minPower: 520_000, multiplier: 5 }, { minPower: 2_600_000, multiplier: 20 }, { minPower: 10_400_000, multiplier: 'unlimited' as const }],
    } : null,
    usageShareBps: [1200, 800, 450, 300, 200, null, 90, 600][index]!,
    washFlagged: index === 6,
    lastSeen: now - index * 60_000,
    health: { failureStreak: index === 4 ? 3 : 0, coolingDownUntil: index === 4 ? now + 5 * 60_000 : null },
    latencyMsP50: [420, 610, 950, 1800, 700, null, 520, 480][index]!,
    firstTokenMsP50: [310, 450, 720, 1300, 520, null, 380, 340][index]!,
    tokensPerSecondP50: [88, 62, 41, 24, 70, null, 95, 110][index]!,
    requests24h: [912, 340, 120, 55, 20, 0, 0, 210][index]!,
  }))
  // A routing service: sells rankings, not models, so it lists none.
  // Beta's first model is priced, and free only for its stakers: 45M power (≈ 865k ANTS locked for a year) gets 200 a day.
  const beta = peers[1]!
  beta.services = beta.services.map((service, m) => m === 0 ? {
    ...service,
    freeTier: { base: { maxRequestsPerAddress: 200, maxRequestsPerIp: null, windowMs: 86_400_000, stakersOnly: true }, stakeTiers: [{ minPower: 45_000_000, multiplier: 1 }] },
  } : service)
  const delta = peers[3]!
  delta.services = delta.services.map((service) => ({ ...service, freeTier: delta.freeTier }))
  // Each seller's announced self check: buyer traffic or its own probe, Beta's first model out of credit, Eta not checked yet.
  for (const [index, peer] of peers.entries()) {
    peer.services = peer.services.map((service, m) => ({
      ...service,
      health: index === 1 && m === 0
        ? { status: 'failing' as const, checkedAt: now - 60_000, source: 'probe' as const, failingSince: now - 18 * 60_000, consecutiveFailures: 4, reason: 'out_of_credit', httpStatus: 402 }
        : index === 6
          ? { status: 'unknown' as const, checkedAt: null, source: null, failingSince: null, consecutiveFailures: null, reason: null, httpStatus: null }
          : { status: 'healthy' as const, checkedAt: now - ((index + m) % 5 + 1) * 60_000 * (m % 2 ? 7 : 1), source: (index + m) % 2 ? 'probe' as const : 'traffic' as const, failingSince: null, consecutiveFailures: null, reason: null, httpStatus: null },
    }))
  }
  const fakeRouter: Peer = { ...peers[7]!, peerId: fakePeerId(9), displayName: 'Fake Router Iota', services: [], verified: false, verificationLinks: [], tee: false, teeScope: null, washFlagged: false, requests24h: 48 }
  peers.push(fakeRouter)
  const peerLists: PeerList[] = [
    { id: 'pl_own', name: 'Our sellers', description: 'Sellers we run ourselves', peerIds: [fakePeerId(1), fakePeerId(3)], createdAt: now - 5 * DAY },
  ]
  const presets: Preset[] = [
    { id: 'pre_1', slug: 'code-review', name: 'Code review', workspaceId: 'ws_default', model: 'qwen3-coder-480b', routingPolicy: { requireVerified: true }, systemPrompt: 'You are a careful code reviewer.', params: { temperature: 0.2 }, createdAt: now - 3 * DAY },
  ]
  const invites: Invite[] = [
    { id: 'inv_1', label: 'Robin Contractor', email: null, orgRole: 'member', expiresAt: now + 2 * DAY, createdAt: now - DAY },
  ]
  const adminTokens: AdminToken[] = [
    { id: 'tok_1', label: 'Terraform', hint: 'antseed_admin_…9f2c', scope: 'admin', createdByMemberId: 'mem_owner', expiresAt: now + 75 * DAY, createdAt: now - 15 * DAY, lastUsedAt: now - 2 * DAY },
  ]
  const channels: Record<string, Channel[]> = {
    ws_default: [
      { channelId: `0x${'c1'.repeat(32)}`, peerId: fakePeerId(1), sellerName: 'Fake Seller Alpha', status: 'active', reserved: '10.000000', spent: '3.412000', settled: '3.000000', openedAt: now - 2 * DAY, canCooperativeClose: true, closeRequestedAt: null },
      // Its seller "fails" a cooperative close in the mock, to show the on-chain fallback.
      { channelId: `0x${'c2'.repeat(32)}`, peerId: fakePeerId(2), sellerName: 'Fake Seller Beta', status: 'active', reserved: '5.000000', spent: '0.902000', settled: '0.500000', openedAt: now - DAY, canCooperativeClose: true, closeRequestedAt: null },
      { channelId: `0x${'c3'.repeat(32)}`, peerId: fakePeerId(3), sellerName: null, status: 'closing', reserved: '1.000000', spent: '0.120000', settled: '0.120000', openedAt: now - 3 * DAY, canCooperativeClose: false, closeRequestedAt: now - 6 * 60_000 },
      { channelId: `0x${'c4'.repeat(32)}`, peerId: fakePeerId(4), sellerName: 'Fake Seller Delta', status: 'withdrawable', reserved: '2.000000', spent: '0.450000', settled: '0.450000', openedAt: now - 5 * DAY, canCooperativeClose: false, closeRequestedAt: now - 40 * 60_000 },
    ],
    ws_research: [],
  }
  const requests: RequestDetail[] = Array.from({ length: 240 }, (_, index) => {
    const k = keys[index % keys.length]!
    const peer = peers[index % 5]!
    const failed = index % 17 === 5
    const startedAt = now - index * 37 * 60_000
    const input = 400 + ((index * 131) % 6000)
    const output = 50 + ((index * 71) % 1500)
    // The newest request still waits for its spend; one an hour or so old never got any; a few were served free.
    const costPending = index === 0 || index === 2
    const servedFree = !failed && index % 13 === 4
    // Every 7th request names the fake router as its model; it picks the model, and request 16's ranking failed.
    const routed = index % 7 === 2
    const rankingFailed = index === 16
    const pickedModel = models[(index + 2) % models.length]!
    // Every 11th request lists the models: no model, no seller, no tokens.
    if (index % 11 === 3) {
      return {
        tag: `req_${String(index).padStart(5, '0')}`, startedAt, finishedAt: startedAt + 60, keyId: k.id, keyLabel: k.label, workspaceId: k.workspaceId, memberId: k.ownerMemberId,
        endUser: null, method: 'GET', path: '/v1/models', model: null, status: 200, sellerPeerId: null, latencyMs: 60, firstTokenMs: null, tokensPerSecond: null, spent: null,
        inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, errorCode: null, errorMessage: null, routeSelection: null, requestBody: null, responseBody: null,
      }
    }
    return {
      tag: `req_${String(index).padStart(5, '0')}`, startedAt, finishedAt: startedAt + 900 + (index % 9) * 120, keyId: k.id, keyLabel: k.label,
      workspaceId: k.workspaceId, memberId: k.ownerMemberId, endUser: index % 4 === 0 ? `user-${index % 7}` : null, method: 'POST',
      path: index % 3 === 0 ? '/v1/messages' : '/v1/chat/completions', model: routed ? 'fake-router' : models[index % models.length]!, status: failed || rankingFailed ? 502 : 200,
      sellerPeerId: failed || rankingFailed ? null : peer.peerId, latencyMs: failed || rankingFailed ? null : 300 + (index % 11) * 90,
      ...(routed ? {
        router: { peerId: fakeRouter.peerId, service: 'fake-router', rank: rankingFailed ? null : index % 21 === 9 ? 2 : 1 },
        ...(rankingFailed ? {} : { servedModel: pickedModel, routingSpent: costPending ? null : '0.000100' }),
      } : {}),
      firstTokenMs: failed || rankingFailed || index % 3 === 1 ? null : 250 + (index % 7) * 60, tokensPerSecond: failed || rankingFailed || index % 3 === 1 ? null : 40 + (index % 8) * 9,
      spent: failed || rankingFailed || costPending || servedFree ? null : ((input * 0.6 + output * 2) / 1e6 + (routed ? 0.0001 : 0)).toFixed(6),
      inputTokens: rankingFailed ? 0 : input, cachedInputTokens: !rankingFailed && index % 5 === 0 ? Math.floor(input / 2) : 0, outputTokens: failed || rankingFailed ? 0 : output,
      ...(costPending ? { costPending: true } : {}),
      ...(servedFree ? { servedFree: true } : {}),
      errorCode: failed ? 'seller_unavailable' : rankingFailed ? 'routing_error' : null,
      errorMessage: failed ? 'No seller accepted the request in time (fake seller timed out).' : rankingFailed ? 'Selected router returned no eligible recommendation' : null,
      routeSelection: routed || failed || rankingFailed ? null : servedSelection(index, now),
      requestBody: index % 6 === 0 ? JSON.stringify({ model: models[index % models.length], messages: [{ role: 'user', content: 'Summarise this fake ticket.' }] }) : null,
      responseBody: index % 6 === 0 && !failed ? JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A short fake summary.' } }] }) : null,
    }
  })
  const gatewayPolicy: RoutingPolicy = { blockedPeerIds: [fakePeerId(7)], minTrustScore: 40 }
  const settings: Settings = {
    publicUrl: 'https://gateway.example.com',
    buyer: {
      proxyPort: 8377,
      maxPricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 60, cachedInputUsdPerMillion: null },
      minPeerReputation: 0,
      routingPreferences: { minTrustScore: 60, maxInputUsdPerMillion: 25, allowedPeerIds: [], blockedPeerIds: [], preferFreePeers: false },
      verifier: { enabled: true, prefer: [], require: false },
      requireVerifier: false,
      payments: { autoSweep: true, maxPerRequestUsdc: 0.3, maxReserveUsdc: 1, rpcUrl: 'https://base-mainnet.example.com/…', fallbackRpcUrls: [] },
      network: { peerRefreshIntervalMs: 300_000, metadataFetchTimeoutMs: 2_000, requestTimeoutMs: 300_000, maxStreamDurationMs: 1_800_000, disableMetadataV2Services: false },
      evidence: { sampleRate: null, maxSampleBytes: null },
      overrides: ['network.metadataFetchTimeoutMs'],
    },
    observability: { otlpEndpoint: null, otlpHeaders: {}, logContent: false, retentionDays: 30 },
    auth: { setupRequired: false, passkey: true, wallet: true, oidc: { label: 'Example SSO' }, cloudflareAccess: false, apiKeyLogin: true },
  }
  const chain: ChainInfo = {
    chainId: 84532, name: 'Base Sepolia', rpcUrl: 'https://sepolia.base.org', explorerUrl: 'https://sepolia.basescan.org',
    contracts: { usdc: fakeAddress(101), deposits: fakeAddress(102), usageRewards: fakeAddress(103), channels: fakeAddress(104) },
  }
  const authConfig: AuthConfig = settings.auth
  const actions = ['key.create', 'workspace.policy.update', 'invite.create', 'routing.default.update', 'key.revoke', 'settings.buyer.update', 'peer_list.update']
  const auditTarget = (action: string, index: number): AuditEntry['target'] => {
    const key = keys[index % keys.length]!
    if (action.startsWith('key')) return { kind: 'key', id: key.id, label: key.label }
    if (action.startsWith('workspace')) return { kind: 'workspace', id: 'ws_default', label: 'Default' }
    return null
  }
  const audit: AuditEntry[] = Array.from({ length: 75 }, (_, index) => {
    const member = members[index % 3]!
    const action = actions[index % actions.length]!
    return {
      id: `aud_${String(index).padStart(4, '0')}`, at: now - index * 3 * 3600_000,
      actor: index % 11 === 10 ? { kind: 'token' as const, id: 'tok_1', label: 'Terraform' } : { kind: 'member' as const, id: member.id, label: member.label },
      action,
      target: auditTarget(action, index),
      details: action === 'workspace.policy.update' ? { before: null, after: { sort: 'price' } } : {},
      ip: index % 4 === 0 ? '192.0.2.10' : null,
    }
  })
  return { audit, members, workspaces, workspaceMembers, keys, peers, peerLists, presets, invites, adminTokens, channels, requests, gatewayPolicy, settings, chain, authConfig }
}

const range = (values: Array<number | null>) => {
  const known = values.filter((value): value is number => value !== null)
  return known.length ? { min: Math.min(...known), max: Math.max(...known) } : null
}

/** `GET /models` for the mock: the sellers' text models, plus an image and a video model. */
export function mockNetworkModels(peers: readonly Peer[]): NetworkModel[] {
  const offers = new Map<string, NetworkModelOffer[]>()
  for (const peer of peers) {
    for (const service of peer.services) {
      // Buyers leave out offers their seller reports failing.
      if (service.health?.status === 'failing') continue
      const free = service.inputUsdPerMillion === 0 && (service.outputUsdPerMillion ?? 0) === 0
      const list = offers.get(service.service) ?? []
      list.push({
        peerId: peer.peerId, displayName: peer.displayName, serviceId: service.service, provider: service.provider,
        protocols: service.apiProtocols ?? ['openai-chat-completions'], inputUsdPerMillion: service.inputUsdPerMillion,
        outputUsdPerMillion: service.outputUsdPerMillion, cachedInputUsdPerMillion: service.cachedInputUsdPerMillion, usdPerImage: null,
        contextLength: service.service.includes('llama') ? 128_000 : service.service.includes('qwen') ? 262_144 : null, free,
        agentId: peer.agentId, freeTier: service.freeTier ?? (free ? peer.freeTier : null),
        reputationScore: peer.reputationScore, trustScore: peer.trustScore, verified: peer.verified, verificationLinks: peer.verificationLinks, tee: peer.tee, teeScope: peer.teeScope, latencyMsP50: peer.latencyMsP50, firstTokenMsP50: peer.firstTokenMsP50, tokensPerSecondP50: peer.tokensPerSecondP50,
        ...(service.health ? { health: service.health } : {}),
      })
      offers.set(service.service, list)
    }
  }
  const media = (id: string, type: 'image' | 'video', price: number): [string, NetworkModelOffer[], 'image' | 'video'] => [id, peers.slice(0, 2).map((peer, index) => ({
    peerId: peer.peerId, displayName: peer.displayName, serviceId: id, provider: 'fal', protocols: [], inputUsdPerMillion: null, outputUsdPerMillion: null,
    cachedInputUsdPerMillion: null, usdPerImage: { min: price * (index + 1), max: price * (index + 1) }, contextLength: null, free: false, agentId: peer.agentId, freeTier: null,
    reputationScore: peer.reputationScore, trustScore: peer.trustScore, verified: peer.verified, verificationLinks: peer.verificationLinks, tee: peer.tee, teeScope: peer.teeScope, latencyMsP50: peer.latencyMsP50, firstTokenMsP50: peer.firstTokenMsP50, tokensPerSecondP50: peer.tokensPerSecondP50,
  })), type]
  const entries: Array<[string, NetworkModelOffer[], NetworkModel['type']]> = [
    ...[...offers].map(([id, list]): [string, NetworkModelOffer[], NetworkModel['type']] => [id, list, 'text']),
    media('flux-schnell', 'image', 0.003),
    media('wan-2.2', 'video', 0.4),
  ]
  return entries.map(([id, list, type]) => {
    const ranked = [...list].sort((a, b) => (b.reputationScore ?? -1) - (a.reputationScore ?? -1))
    return {
      id, name: id, aliases: id.includes('.') ? [id.replace(/\./g, '-')] : [], type, tags: mockTags(id),
      contextLength: range(ranked.map((offer) => offer.contextLength))?.max ?? null,
      capabilities: type === 'text' ? (id.includes('qwen3-coder') || id.includes('kimi') ? ['toolUse', 'structuredOutput'] : ['toolUse']) : [],
      sellers: ranked.length,
      inputUsdPerMillion: range(ranked.map((offer) => offer.inputUsdPerMillion)),
      outputUsdPerMillion: range(ranked.map((offer) => offer.outputUsdPerMillion)),
      free: ranked.some((offer) => offer.free && !offer.freeTier?.base.stakersOnly),
      freeForStakers: ranked.some((offer) => offer.freeTier?.base.stakersOnly === true),
      freeAllowance: ranked.some((offer) => !offer.free && offer.freeTier !== null && !offer.freeTier.base.stakersOnly),
      teeSellers: ranked.filter((offer) => offer.tee).length,
      fullTeeSellers: ranked.filter((offer) => offer.teeScope === 'end-to-end').length,
      verifiedSellers: ranked.filter((offer) => offer.verified).length,
      offers: ranked,
    }
  })
}

/** Fake release tags, by model name (the real ones come from the gateway's model registry). */
function mockTags(id: string): string[] {
  const tags: string[] = []
  if (id.includes('coder')) tags.push('Coding')
  if (/r1|thinking|kimi/.test(id)) tags.push('Reasoning')
  if (id.includes('vl')) tags.push('Vision')
  if (/llama|qwen|deepseek|gpt-oss|glm|gemma|olmo/.test(id)) tags.push('Open weights')
  if (/flash|schnell|air/.test(id)) tags.push('Fast')
  return tags
}

/** Fake routing services: one free, one charging per ranking. */
export function mockNetworkRouters(peers: readonly Peer[]): NetworkRouter[] {
  const option = { key: 'cost_quality_tradeoff', type: 'integer' as const, label: 'Cost vs. quality', minimum: 0, maximum: 10, default: 5,
    description: '0 picks the best quality regardless of price; 10 picks the cheapest acceptable model.' }
  return [
    { id: `${peers[0]!.peerId}@fake-router`, peerId: peers[0]!.peerId, serviceId: 'fake-router', provider: 'fake-routing', name: 'Fake Router Iota',
      sellerName: peers[0]!.displayName, protocol: 'irp-suggest', options: [option], priceUsdPerRequest: 0, free: true, models: ['*'],
      trustScore: peers[0]!.trustScore, verified: peers[0]!.verified, verificationLinks: peers[0]!.verificationLinks },
    { id: `${peers[2]!.peerId}@fake-quality-router`, peerId: peers[2]!.peerId, serviceId: 'fake-quality-router', provider: 'fake-routing', name: 'Fake Quality Router',
      sellerName: peers[2]!.displayName, protocol: 'irp-suggest', options: [option], priceUsdPerRequest: 0.0005, free: false,
      models: ['deepseek-v3.1', 'qwen3-coder-480b', 'kimi-k2'], trustScore: peers[2]!.trustScore, verified: peers[2]!.verified, verificationLinks: peers[2]!.verificationLinks },
  ]
}
