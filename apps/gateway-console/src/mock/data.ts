import type {
  AdminToken, ApiKey, AuditEntry, AuthConfig, Channel, ChainInfo, Invite, Member, Peer, PeerList, Preset, RequestDetail, RoutingPolicy, Settings, Workspace, WorkspaceRole,
} from '../api/types'

/** Obvious fake peer ids for the mock: 0xfa1e…0001 etc. */
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
      return { provider: 'openai', service, inputUsdPerMillion: free ? 0 : Number(base.toFixed(2)), outputUsdPerMillion: free ? 0 : Number((base * 3).toFixed(2)), cachedInputUsdPerMillion: free ? 0 : Number((base / 4).toFixed(3)), categories: ['chat'] }
    }),
    trustScore: [92, 78, 88, 41, 65, null, 55, 83][index]!,
    reputationScore: [90, 74, 85, 50, 60, null, 52, 80][index]!,
    verified: index === 2 || index === 0,
    tee: index === 2,
    stakeAnts: index < 5 ? `${(index + 1) * 2500}.0` : null,
    usageShareBps: [1200, 800, 450, 300, 200, null, 90, 600][index]!,
    washFlagged: index === 6,
    lastSeen: now - index * 60_000,
    health: { failureStreak: index === 4 ? 3 : 0, coolingDownUntil: index === 4 ? now + 5 * 60_000 : null },
    latencyMsP50: [420, 610, 950, 1800, 700, null, 520, 480][index]!,
    requests24h: [912, 340, 120, 55, 20, 0, 0, 210][index]!,
  }))
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
      { channelId: 'ch_1', peerId: fakePeerId(1), sellerName: 'Fake Seller Alpha', status: 'active', reserved: '10.000000', spent: '3.412000', openedAt: now - 2 * DAY, canCooperativeClose: true },
      { channelId: 'ch_2', peerId: fakePeerId(2), sellerName: 'Fake Seller Beta', status: 'active', reserved: '5.000000', spent: '0.902000', openedAt: now - DAY, canCooperativeClose: true },
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
    // The newest request still waits for its spend; one an hour or so old never got any.
    const costPending = index === 0 || index === 2
    return {
      tag: `req_${String(index).padStart(5, '0')}`, startedAt, finishedAt: startedAt + 900 + (index % 9) * 120, keyId: k.id, keyLabel: k.label,
      workspaceId: k.workspaceId, memberId: k.ownerMemberId, endUser: index % 4 === 0 ? `user-${index % 7}` : null, method: 'POST',
      path: index % 3 === 0 ? '/v1/messages' : '/v1/chat/completions', model: models[index % models.length]!, status: failed ? 502 : 200,
      sellerPeerId: failed ? null : peer.peerId, latencyMs: failed ? null : 300 + (index % 11) * 90, spent: failed || costPending ? null : ((input * 0.6 + output * 2) / 1e6).toFixed(6),
      inputTokens: input, cachedInputTokens: index % 5 === 0 ? Math.floor(input / 2) : 0, outputTokens: failed ? 0 : output,
      ...(costPending ? { costPending: true } : {}),
      errorCode: failed ? 'seller_unavailable' : null,
      errorMessage: failed ? 'No seller accepted the request in time (fake seller timed out).' : null,
      requestBody: index % 6 === 0 ? JSON.stringify({ model: models[index % models.length], messages: [{ role: 'user', content: 'Summarise this fake ticket.' }] }) : null,
      responseBody: index % 6 === 0 && !failed ? JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A short fake summary.' } }] }) : null,
    }
  })
  const gatewayPolicy: RoutingPolicy = { blockedPeerIds: [fakePeerId(7)], minTrustScore: 40 }
  const settings: Settings = {
    publicUrl: 'https://gateway.example.com',
    buyer: { proxyPort: 8377, maxPricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 60, cachedInputUsdPerMillion: null }, minPeerReputation: 0, requireVerifier: false },
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
