import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import {
  ANTSEED_BUYER_FAULT_ERROR_CODE,
  ANTSEED_FAULT_ATTRIBUTION_HEADER,
  CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
  CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1,
  adaptPeerFaultErrorResponse,
  buyerFault,
  computeTrustScore,
  type ModelRoutingPreferences,
  type PeerInfo,
  type SerializedHttpResponse,
} from '@antseed/node'
import { DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS } from '../config/defaults.js'
import { TeeVerification } from './tee-verification.js'
import {
  BuyerProxy,
  isModelNotFoundResponse,
  makeVerifierReach,
  mergeJsonStateFile,
  parsePeerPinnedService,
  parsePersistedPeers,
  rewritePeerPinnedServiceInBody,
  sanitizePeerBuyerFaultMarker,
  selectCandidatePeersForRouting,
  substituteRoutedModelAlias,
  sweepStaleStateTmpFiles,
} from './buyer-proxy.js'
import {
  extractRequestedService,
  overrideRoutedModelInBody,
  SYSTEM_ROUTED_MODEL_HEADER,
} from './request-utils.js'

function makePeer(seed: string, providers: string[]): PeerInfo {
  const repeated = (seed.repeat(40) + 'a'.repeat(40)).slice(0, 40)
  return {
    peerId: repeated as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers,
  }
}

test('existing required CLI verification rejects a failed pin without payment/inference and auto falls back to a verified seller', async () => {
  const rejected = makePeer('a', ['openai'])
  const accepted = makePeer('b', ['openai'])
  for (const peer of [rejected, accepted]) {
    peer.capabilities = ['verifier.antseed-verifier']
    peer.providerServiceApiProtocols = { openai: { services: { 'gpt-4o': ['openai-chat-completions'] } } }
  }
  rejected.reputationScore = 99
  accepted.reputationScore = 90
  const peers = [rejected, accepted]
  const proxy = makeBuyerProxyWithPeers(peers, peers, permissiveRouter())
  const policy = { require: true, prefer: ['antseed-verifier'] }
  const verification = new TeeVerification(policy)
  ;(proxy as any)._verifier = policy
  ;(proxy as any)._teeVerification = verification
  ;(proxy as any)._cachedPeers = peers
  await verification.verify(rejected, policy, async () => ({ ok: false, verified: false, reason: 'Seller binding failed' }))
  await verification.verify(accepted, policy, async () => ({ ok: true, verified: true, sellerNodeVerified: true }))
  const dispatches: string[] = []
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    dispatches.push(peer.peerId)
    return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') }
  }
  const pinned = await invokeProxy(proxy, makeProxyRequest({ headers: { 'x-antseed-pin-peer': rejected.peerId } }))
  assert.equal(pinned.statusCode, 502)
  assert.match(pinned.body, /failed required verification/)
  assert.deepEqual(dispatches, [])
  const automatic = await invokeProxy(proxy, makeProxyRequest({}))
  assert.equal(automatic.statusCode, 200)
  assert.deepEqual(dispatches, [accepted.peerId])
  const explicit = await invokeProxy(proxy, makeProxyRequest({ headers: { 'x-antseed-pin-peer': accepted.peerId } }))
  assert.equal(explicit.statusCode, 200)
  assert.deepEqual(dispatches, [accepted.peerId, accepted.peerId])
});

function makeProxyRequest(options: {
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: Record<string, unknown>
}): Readable {
  const body = JSON.stringify(options.body ?? { model: 'gpt-4o', messages: [] })
  const req = Readable.from([Buffer.from(body)]) as Readable & {
    method: string
    url: string
    headers: Record<string, string>
    complete: boolean
  }
  req.method = options.method ?? 'POST'
  req.url = options.path ?? '/v1/chat/completions'
  req.headers = {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  }
  req.complete = true
  return req
}

function makeProxyResponse(): {
  statusCode: number
  headers: Record<string, string>
  body: string
  headersSent: boolean
  writableEnded: boolean
  writeHead: (statusCode: number, headers: Record<string, string>) => unknown
  write: (chunk: string | Buffer | Uint8Array) => unknown
  end: (chunk?: string | Buffer | Uint8Array) => unknown
  once: () => unknown
} {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode
      this.headers = headers
      this.headersSent = true
      return this
    },
    write(chunk: string | Buffer | Uint8Array) {
      this.body += Buffer.from(chunk).toString('utf8')
      return true
    },
    end(chunk?: string | Buffer | Uint8Array) {
      if (chunk !== undefined) {
        this.body += Buffer.from(chunk).toString('utf8')
      }
      this.writableEnded = true
      return this
    },
    once() {
      return this
    },
  }
}

function makeBuyerProxyWithPeers(
  initialPeers: PeerInfo[],
  refreshedPeers = initialPeers,
  router: unknown = null,
  now?: () => number,
  routingPreferences?: ModelRoutingPreferences,
): BuyerProxy {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: {
      router,
    } as any,
    ...(now ? { now } : {}),
    ...(routingPreferences ? { routingPreferences } : {}),
  })
  ;(proxy as any)._getPeers = async (options?: { forceRefresh?: boolean }) =>
    options?.forceRefresh ? refreshedPeers : initialPeers
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  return proxy
}

const priceAndTrustPreferences: ModelRoutingPreferences = {
  preferFreePeers: false,
  maxInputUsdPerMillion: 25,
  minTrustScore: 60,
  allowedPeerIds: [],
  blockedPeerIds: [],
}

/**
 * A hand-cranked clock for peer-health tests.
 *
 * Health bookkeeping coalesces failures landing within a second of each other,
 * so back-to-back in-process requests would otherwise register as one episode.
 * Real failures are spaced by connect/request timeouts; these tests advance the
 * clock explicitly to model that without sleeping.
 */
function makeTestClock(start = 1_700_000_000_000) {
  let current = start
  return {
    now: () => current,
    advance(ms: number) { current += ms },
  }
}

/** Router stub that permits every peer and ignores result telemetry. */
function permissiveRouter() {
  return { allowsPeerForPolicy: () => true, onResult: () => {} }
}

/** Drive `times` failed requests at a pinned peer, spaced past the coalesce window. */
async function failRepeatedly(
  proxy: BuyerProxy,
  peer: PeerInfo,
  clock: ReturnType<typeof makeTestClock>,
  times = 3,
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await invokeProxy(proxy, makeProxyRequest({ headers: { 'x-antseed-pin-peer': peer.peerId } }))
    clock.advance(5_000)
  }
}

function healthOf(proxy: BuyerProxy, peer: PeerInfo) {
  return (proxy as any)._peerHealth.get(peer.peerId)
}

async function invokeProxy(proxy: BuyerProxy, req: Readable): Promise<ReturnType<typeof makeProxyResponse>> {
  const res = makeProxyResponse()
  await (proxy as any)._handleRequest(req, res)
  return res
}

test('BuyerProxy defaults to the configured 5 min background refresh interval', () => {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null } as any,
  })

  assert.equal((proxy as any)._bgRefreshIntervalMs, DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS)
})

test('BuyerProxy accepts a custom background refresh interval', () => {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null } as any,
    backgroundRefreshIntervalMs: 15_000,
  })

  assert.equal((proxy as any)._bgRefreshIntervalMs, 15_000)
})

test('BuyerProxy reloads model routing preferences from config', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'antseed-routing-config-'))
  const configPath = join(dataDir, 'config.json')
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const allowedPeerId = 'a'.repeat(40)

  await writeFile(configPath, JSON.stringify({
    buyer: {
      routingPreferences: {
        preferFreePeers: true,
        maxInputUsdPerMillion: 8,
        minTrustScore: 72,
        allowedPeerIds: [allowedPeerId],
        blockedPeerIds: [],
      },
    },
  }))

  const proxy = new BuyerProxy({
    port: 0,
    dataDir,
    configPath,
    routingPreferences: priceAndTrustPreferences,
    node: { router: null } as any,
  })

  await (proxy as any)._reloadRoutingPreferences()

  assert.deepEqual((proxy as any)._routingPreferences, {
    preferFreePeers: true,
    maxInputUsdPerMillion: 8,
    minTrustScore: 72,
    allowedPeerIds: [allowedPeerId],
    blockedPeerIds: [],
  })
})

test('BuyerProxy starts incremental discovery on startup', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-proxy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let sweepCalls = 0
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: dir,
    node: {
      router: null,
      on: () => undefined,
      startBackgroundPeerDiscoverySweep: () => { sweepCalls += 1 },
    } as any,
    backgroundRefreshIntervalMs: 60 * 60_000,
  })
  ;(proxy as any)._refreshPeersNow = async () => []

  await proxy.start()
  await proxy.stop()

  assert.equal(sweepCalls, 1)
})

test('selectCandidatePeersForRouting enforces explicit provider overrides even without request protocol', () => {
  const peers = [
    makePeer('a', ['anthropic']),
    makePeer('b', ['openai']),
  ]

  const result = selectCandidatePeersForRouting(peers, null, null, 'openai')
  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, peers[1]?.peerId)
  assert.equal(result.routePlanByPeerId.get(peers[1]!.peerId)?.provider, 'openai')
  assert.equal(result.routePlanByPeerId.get(peers[1]!.peerId)?.selection, null)
})

test('selectCandidatePeersForRouting returns no candidates when explicit provider is unavailable', () => {
  const peers = [
    makePeer('a', ['anthropic']),
    makePeer('b', ['local-llm']),
  ]

  const result = selectCandidatePeersForRouting(peers, null, null, 'openai')
  assert.equal(result.candidatePeers.length, 0)
  assert.equal(result.routePlanByPeerId.size, 0)
})

test('selectCandidatePeersForRouting keeps all peers when no protocol or provider override is set', () => {
  const peers = [
    makePeer('a', ['anthropic']),
    makePeer('b', ['openai']),
  ]

  const result = selectCandidatePeersForRouting(peers, null, null, null)
  assert.deepEqual(result.candidatePeers.map((peer) => peer.peerId), peers.map((peer) => peer.peerId))
  assert.equal(result.routePlanByPeerId.size, 0)
})

test('sweep control endpoint validates and dispatches sequentially via the running node', async () => {
  const validSweep = {
    version: 1,
    evmChainId: 31337,
    relayAddress: '0x' + '8a'.repeat(20),
    from: '0x' + '11'.repeat(20),
    amount: '5000000',
    validAfter: 0,
    validBefore: 2_000_000_000,
    nonce: '0x' + 'aa'.repeat(32),
    sig3009: '0x' + 'ab'.repeat(65),
  }

  const dispatches: unknown[] = []
  const listeners = new Map<string, (event: unknown) => void>()
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: {
      router: null,
      on: (event: string, listener: (event: unknown) => void) => listeners.set(event, listener),
      dispatchSweepRequest: async (payload: unknown) => {
        dispatches.push(payload)
        return { offered: 3, accepted: true }
      },
    } as any,
  })

  const res = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/sweep', body: validSweep }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, sent: 3, accepted: true })
  assert.equal(dispatches.length, 1)

  // Malformed payloads are rejected by the wire codec, not dispatched.
  const bad = await invokeProxy(proxy, makeProxyRequest({
    path: '/_antseed/sweep',
    body: { ...validSweep, sig3009: 'garbage' },
  }))
  assert.equal(bad.statusCode, 400)
  assert.equal(dispatches.length, 1)

  // Receipts surfaced via node events are readable per-nonce.
  const emit = listeners.get('sweep:receipt')
  assert.ok(emit, 'proxy subscribes to sweep:receipt')
  emit!({ peerId: 'p1', payload: { version: 1, authNonce: validSweep.nonce, status: 'confirmed', txHash: '0x' + '77'.repeat(32) } })

  const receiptRes = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: `/_antseed/sweep/${validSweep.nonce}` }))
  assert.equal(receiptRes.statusCode, 200)
  const receiptBody = JSON.parse(receiptRes.body) as { ok: boolean; receipt: { status: string; txHash: string } }
  assert.equal(receiptBody.receipt.status, 'confirmed')
  assert.equal(receiptBody.receipt.txHash, '0x' + '77'.repeat(32))

  // Unknown nonce returns null receipt.
  const missing = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: `/_antseed/sweep/0x${'bb'.repeat(32)}` }))
  assert.deepEqual(JSON.parse(missing.body), { ok: true, receipt: null })
})

test('peer refresh control endpoint triggers immediate refresh', async () => {
  const refreshedPeer = makePeer('a', ['anthropic'])
  const proxy = makeBuyerProxyWithPeers([], [refreshedPeer])
  let refreshCalled = false
  ;(proxy as any)._refreshPeersNow = async () => {
    refreshCalled = true
    return [refreshedPeer]
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/peers/refresh' }))
  const body = JSON.parse(res.body) as { ok: boolean; total: number }

  assert.equal(refreshCalled, true)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(body, { ok: true, total: 1 })
})

test('peers control endpoint exposes relay capability metadata', async () => {
  const peer = makePeer('a', ['openai'])
  peer.capabilities = [CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1]
  const proxy = makeBuyerProxyWithPeers([peer])

  const res = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/peers' }))
  const body = JSON.parse(res.body) as { peers: Array<{ capabilities: string[] }> }

  assert.equal(res.statusCode, 200)
  assert.deepEqual(body.peers[0]?.capabilities, [CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1])
})

test('channels endpoint exposes cooperative-close support from peer capabilities', async () => {
  const supportedPeer = makePeer('a', ['openai'])
  supportedPeer.displayName = '  Seller One  '
  supportedPeer.capabilities = [CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1]
  const unsupportedPeer = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([supportedPeer, unsupportedPeer])
  ;(proxy as any)._node.getAllBuyerChannels = () => [
    { sessionId: 'supported', peerId: supportedPeer.peerId },
    { sessionId: 'unsupported', peerId: unsupportedPeer.peerId },
    { sessionId: 'unknown', peerId: 'c'.repeat(40) },
  ]

  const res = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/channels?all=1' }))
  const body = JSON.parse(res.body) as {
    channels: Array<{ sessionId: string; sellerDisplayName: string | null; cooperativeCloseSupported: boolean }>
  }

  assert.equal(res.statusCode, 200)
  assert.deepEqual(
    body.channels.map((channel) => [channel.sessionId, channel.sellerDisplayName, channel.cooperativeCloseSupported]),
    [
      ['supported', 'Seller One', true],
      ['unsupported', null, false],
      ['unknown', null, false],
    ],
  )
})

test('selectCandidatePeersForRouting excludes peers when requested service is not in provider metadata', () => {
  const openAiPeer = makePeer('a', ['openai'])
  openAiPeer.providerServiceApiProtocols = {
    openai: {
      services: {
        'gpt-4o': ['openai-chat-completions'],
      },
    },
  }
  const claudePeer = makePeer('b', ['claude-oauth'])
  claudePeer.providerServiceApiProtocols = {
    'claude-oauth': {
      services: {
        'claude-opus-4-6': ['anthropic-messages'],
      },
    },
  }

  const result = selectCandidatePeersForRouting(
    [openAiPeer, claudePeer],
    'anthropic-messages',
    'claude-opus-4-6',
    null,
  )

  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, claudePeer.peerId)
  assert.equal(result.routePlanByPeerId.has(openAiPeer.peerId), false)
  assert.equal(result.routePlanByPeerId.get(claudePeer.peerId)?.provider, 'claude-oauth')
})

test('selectCandidatePeersForRouting in lenient mode keeps a peer whose advertised services miss the requested model, as long as the provider protocol set matches', () => {
  // The buyer explicitly pinned this peer. It advertises one service
  // (kimi-k2.6 over openai-chat-completions) but the request asks for
  // anthropic-messages with model="claude-4". Strict mode would drop the
  // peer; lenient mode keeps it and relies on the cross-protocol adapter
  // plus the seller's upstream error to surface "model not found".
  const peer = makePeer('a', ['openai'])
  peer.providerServiceApiProtocols = {
    openai: {
      services: {
        'kimi-k2.6': ['openai-chat-completions'],
      },
    },
  }

  const strict = selectCandidatePeersForRouting([peer], 'anthropic-messages', 'claude-4', null, 'strict')
  assert.equal(strict.candidatePeers.length, 0, 'strict mode should drop the peer on service mismatch')

  const lenient = selectCandidatePeersForRouting([peer], 'anthropic-messages', 'claude-4', null, 'lenient')
  assert.equal(lenient.candidatePeers.length, 1, 'lenient mode should keep the peer on service mismatch')
  const plan = lenient.routePlanByPeerId.get(peer.peerId)
  assert.ok(plan, 'expected a route plan for the lenient-kept peer')
  assert.equal(plan!.provider, 'openai')
  // Anthropic→openai transform should be the selected path.
  assert.equal(plan!.selection?.requiresTransform, true)
})

test('selectCandidatePeersForRouting in lenient mode prefers exact service matches before provider fallback', () => {
  const peer = makePeer('a', ['openai', 'local-llm'])
  peer.providerServiceApiProtocols = {
    openai: {
      services: {
        'gpt-4o': ['openai-chat-completions'],
      },
    },
    'local-llm': {
      services: {
        llama: ['openai-chat-completions'],
      },
    },
  }

  const result = selectCandidatePeersForRouting(
    [peer],
    'openai-chat-completions',
    'llama',
    null,
    'lenient',
  )

  assert.equal(result.candidatePeers.length, 1)
  const plan = result.routePlanByPeerId.get(peer.peerId)
  assert.ok(plan, 'expected a route plan for the lenient-kept peer')
  assert.equal(plan!.provider, 'local-llm')
  assert.equal(plan!.selection?.requiresTransform, false)
  assert.equal(plan!.serviceId, 'llama')
})

test('selectCandidatePeersForRouting derives protocol from the selected cheapest alias', () => {
  const peer = makePeer('a', ['openai', 'claude-oauth'])
  peer.providerPricing = {
    openai: { defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 25 }, services: { 'claude-opus-5': { inputUsdPerMillion: 5, outputUsdPerMillion: 25 } } },
    'claude-oauth': { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 5 }, services: { 'opus-5': { inputUsdPerMillion: 1, outputUsdPerMillion: 5 } } },
  }
  peer.providerServiceApiProtocols = {
    openai: { services: { 'claude-opus-5': ['openai-chat-completions'] } },
    'claude-oauth': { services: { 'opus-5': ['anthropic-messages'] } },
  }

  const result = selectCandidatePeersForRouting(
    [peer],
    'openai-chat-completions',
    'Claude Opus 5',
    null,
  )

  const plan = result.routePlanByPeerId.get(peer.peerId)
  assert.ok(plan)
  assert.equal(plan.provider, 'claude-oauth')
  assert.equal(plan.serviceId, 'opus-5')
  assert.equal(plan.selection?.targetProtocol, 'anthropic-messages')
  assert.equal(plan.selection?.requiresTransform, true)
})

test('selectCandidatePeersForRouting prefers a full service over a cheaper coding-only alias', () => {
  const peer = makePeer('a', ['anthropic', 'claude-oauth'])
  peer.providerPricing = {
    anthropic: { defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 25 }, services: { 'claude-opus-5': { inputUsdPerMillion: 5, outputUsdPerMillion: 25 } } },
    'claude-oauth': { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 5 }, services: { 'opus-5-coding-only': { inputUsdPerMillion: 1, outputUsdPerMillion: 5 } } },
  }
  peer.providerServiceApiProtocols = {
    anthropic: { services: { 'claude-opus-5': ['anthropic-messages'] } },
    'claude-oauth': { services: { 'opus-5-coding-only': ['anthropic-messages'] } },
  }

  const result = selectCandidatePeersForRouting([peer], 'anthropic-messages', 'opus-5', null)
  const plan = result.routePlanByPeerId.get(peer.peerId)
  assert.ok(plan)
  assert.equal(plan.provider, 'anthropic')
  assert.equal(plan.serviceId, 'claude-opus-5')
})

test('selectCandidatePeersForRouting excludes coding-only-only peers from unrestricted requests', () => {
  const peer = makePeer('a', ['claude-oauth'])
  peer.providerServiceApiProtocols = {
    'claude-oauth': { services: { 'opus-5-coding-only': ['anthropic-messages'] } },
  }

  const unrestricted = selectCandidatePeersForRouting([peer], 'anthropic-messages', 'opus-5', null)
  assert.equal(unrestricted.candidatePeers.length, 0)

  const explicit = selectCandidatePeersForRouting([peer], 'anthropic-messages', 'opus-5-coding-only', null)
  assert.equal(explicit.candidatePeers.length, 1)
  assert.equal(explicit.routePlanByPeerId.get(peer.peerId)?.serviceId, 'opus-5-coding-only')
})

test('selectCandidatePeersForRouting can still include peers without service protocol metadata', () => {
  const peerWithoutMetadata = makePeer('a', ['openai'])
  const result = selectCandidatePeersForRouting(
    [peerWithoutMetadata],
    'openai-chat-completions',
    'gpt-4o',
    null,
  )

  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, peerWithoutMetadata.peerId)
})

test('model-only request routes to the highest-ranked canonical service match', async () => {
  const lower = makePeer('a', ['anthropic'])
  lower.onChainReputationScore = 40
  lower.providerServiceApiProtocols = {
    anthropic: { services: { 'Claude Opus 5': ['anthropic-messages'] } },
  }
  const higher = makePeer('b', ['anthropic'])
  higher.onChainReputationScore = 90
  higher.providerServiceApiProtocols = {
    anthropic: { services: { 'opus-5': ['anthropic-messages'] } },
  }
  const proxy = makeBuyerProxyWithPeers([lower, higher], [lower, higher], permissiveRouter())
  let selectedPeerId = ''
  let selectedBody: Record<string, unknown> | null = null
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string; body: Uint8Array }) => {
    selectedPeerId = peer.peerId
    selectedBody = parseJsonBody(request.body)
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ok: true })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/messages',
    body: { model: 'claude-opus-5', max_tokens: 32, messages: [] },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedPeerId, higher.peerId)
  assert.equal(selectedBody?.['model'], 'opus-5')
})

test('required parameters filter automatic routes and are stripped before seller dispatch', async () => {
  const unsupported = makePeer('a', ['openai'])
  unsupported.reputationScore = 99
  unsupported.providerServiceApiProtocols = {
    openai: { services: { 'venice-sd35': ['openai-images'] } },
  }
  unsupported.providerServiceCapabilities = {
    openai: { services: { 'venice-sd35': { outputs: ['image'] } } },
  }
  const supported = makePeer('b', ['openai'])
  supported.reputationScore = 70
  supported.providerServiceApiProtocols = {
    openai: { services: { 'venice-sd35': ['openai-images'] } },
  }
  supported.providerServiceCapabilities = {
    openai: {
      services: {
        'venice-sd35': { outputs: ['image'], supportedParameters: ['moderation'] },
      },
    },
  }
  const proxy = makeBuyerProxyWithPeers(
    [unsupported, supported],
    [unsupported, supported],
    permissiveRouter(),
  )
  let selectedPeerId = ''
  let forwardedHeaders: Record<string, string> = {}
  ;(proxy as any)._node.sendRequest = async (
    peer: PeerInfo,
    request: { requestId: string; headers: Record<string, string> },
  ) => {
    selectedPeerId = peer.peerId
    forwardedHeaders = request.headers
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ data: [{ b64_json: 'image' }] })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/images/generations',
    headers: { 'x-antseed-required-parameters': 'moderation' },
    body: { model: 'venice-sd35', prompt: 'a landscape', moderation: 'low' },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedPeerId, supported.peerId)
  assert.equal(forwardedHeaders['x-antseed-required-parameters'], undefined)
})

test('required parameters fail clearly when no automatic route advertises support', async () => {
  const peer = makePeer('a', ['openai'])
  peer.providerServiceApiProtocols = {
    openai: { services: { 'venice-sd35': ['openai-images'] } },
  }
  peer.providerServiceCapabilities = {
    openai: { services: { 'venice-sd35': { outputs: ['image'] } } },
  }
  const proxy = makeBuyerProxyWithPeers([peer], [peer], permissiveRouter())
  let dispatches = 0
  ;(proxy as any)._node.sendRequest = async () => {
    dispatches += 1
    throw new Error('must not dispatch')
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/images/generations',
    headers: { 'x-antseed-required-parameters': 'moderation' },
    body: { model: 'venice-sd35', prompt: 'a landscape', moderation: 'low' },
  }))

  assert.equal(res.statusCode, 422)
  assert.equal(JSON.parse(res.body).error.code, 'required_capability_unavailable')
  assert.equal(dispatches, 0)
})

test('pinned routes fail clearly when the seller lacks a required parameter', async () => {
  const peer = makePeer('a', ['openai'])
  peer.providerServiceApiProtocols = {
    openai: { services: { 'venice-sd35': ['openai-images'] } },
  }
  peer.providerServiceCapabilities = {
    openai: { services: { 'venice-sd35': { outputs: ['image'] } } },
  }
  const proxy = makeBuyerProxyWithPeers([peer], [peer], permissiveRouter())
  let dispatches = 0
  ;(proxy as any)._node.sendRequest = async () => {
    dispatches += 1
    throw new Error('must not dispatch')
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/images/generations',
    headers: {
      'x-antseed-pin-peer': peer.peerId,
      'x-antseed-required-parameters': 'moderation',
    },
    body: { model: 'venice-sd35', prompt: 'a landscape', moderation: 'low' },
  }))

  assert.equal(res.statusCode, 422)
  assert.equal(JSON.parse(res.body).error.code, 'required_capability_unavailable')
  assert.equal(dispatches, 0)
})

test('conversation routing keeps the actual peer as a soft preference and fails over when needed', async () => {
  const preferred = makePeer('c', ['openai'])
  preferred.reputationScore = 70
  preferred.providerServiceApiProtocols = {
    openai: { services: { 'kimi-k3': ['openai-chat-completions'] } },
  }
  const rankedFirst = makePeer('d', ['openai'])
  rankedFirst.reputationScore = 95
  rankedFirst.providerServiceApiProtocols = {
    openai: { services: { 'Kimi K3': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([rankedFirst, preferred], [rankedFirst, preferred], permissiveRouter())
  const attempts: string[] = []
  let preferredReachable = true
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string; headers: Record<string, string> }) => {
    attempts.push(peer.peerId)
    assert.equal(request.headers['x-vpr-session-id'], undefined)
    assert.equal(request.headers['x-antstation-session-id'], undefined)
    assert.equal(request.headers['x-antseed-prefer-peer'], undefined)
    return {
      requestId: request.requestId,
      statusCode: peer.peerId === preferred.peerId && !preferredReachable ? 503 : 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ peerId: peer.peerId })),
    }
  }

  const conversationHeaders = {
    'x-vpr-session-id': 'conversation-soft-affinity',
    'x-antseed-prefer-peer': preferred.peerId,
  }
  await invokeProxy(proxy, makeProxyRequest({
    headers: conversationHeaders,
    body: { model: 'kimi-k3', messages: [{ role: 'user', content: 'hello' }] },
  }))
  assert.deepEqual(attempts, [preferred.peerId])

  preferredReachable = false
  attempts.length = 0
  await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-vpr-session-id': 'conversation-soft-affinity' },
    body: { model: 'kimi-k3', messages: [{ role: 'user', content: 'again' }] },
  }))
  assert.deepEqual(attempts, [preferred.peerId, rankedFirst.peerId])

  const stored = (proxy as any)._conversations.get('vpr:conversation-soft-affinity')
  assert.equal(stored?.pinnedModel, `${rankedFirst.peerId}@Kimi K3`)
  assert.equal(stored?.lastModel, `${rankedFirst.peerId}@Kimi K3`)

  attempts.length = 0
  await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-vpr-session-id': 'conversation-soft-affinity' },
    body: { model: 'kimi-k3', messages: [{ role: 'user', content: 'third' }] },
  }))
  assert.equal(attempts[0], rankedFirst.peerId)

  const route = await invokeProxy(proxy, makeProxyRequest({
    method: 'GET',
    path: `/_antseed/conversations/${encodeURIComponent('vpr:conversation-soft-affinity')}`,
  }))
  assert.equal(route.statusCode, 200)
  assert.equal(JSON.parse(route.body).conversation.lastModel, `${rankedFirst.peerId}@Kimi K3`)
})

test('model-only request applies a cached-input pricing reputation penalty', async () => {
  const priced = makePeer('a', ['openai'])
  priced.reputationScore = 75
  priced.providerPricing = {
    openai: {
      defaults: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
      services: {
        'cache-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.2 },
      },
    },
  }
  priced.providerServiceApiProtocols = {
    openai: { services: { 'cache-model': ['openai-chat-completions'] } },
  }
  const unpriced = makePeer('b', ['openai'])
  unpriced.reputationScore = 90
  unpriced.providerPricing = {
    openai: {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      services: { 'cache-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
    },
  }
  unpriced.providerServiceApiProtocols = {
    openai: { services: { 'cache-model': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([unpriced, priced], [unpriced, priced], permissiveRouter())
  let selectedPeerId = ''
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    selectedPeerId = peer.peerId
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ok: true })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'cache-model', messages: [] } }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedPeerId, priced.peerId)
})

test('model-only cached-input pricing penalty does not bury a substantially stronger peer', async () => {
  const priced = makePeer('a', ['openai'])
  priced.onChainReputationScore = 20
  priced.providerPricing = {
    openai: {
      defaults: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
      services: {
        'cache-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.2 },
      },
    },
  }
  priced.providerServiceApiProtocols = {
    openai: { services: { 'cache-model': ['openai-chat-completions'] } },
  }
  const unpriced = makePeer('b', ['openai'])
  unpriced.onChainReputationScore = 100
  unpriced.providerServiceApiProtocols = {
    openai: { services: { 'cache-model': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([priced, unpriced], [priced, unpriced], permissiveRouter())
  let selectedPeerId = ''
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    selectedPeerId = peer.peerId
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ok: true })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'cache-model', messages: [] } }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedPeerId, unpriced.peerId)
})

test('model-only request keeps reputation ordering when cached-input pricing is absent for all peers', async () => {
  const lower = makePeer('a', ['openai'])
  lower.onChainReputationScore = 20
  lower.providerServiceApiProtocols = {
    openai: { services: { 'no-cache-model': ['openai-chat-completions'] } },
  }
  const higher = makePeer('b', ['openai'])
  higher.onChainReputationScore = 100
  higher.providerServiceApiProtocols = {
    openai: { services: { 'no-cache-model': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([lower, higher], [lower, higher], permissiveRouter())
  let selectedPeerId = ''
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    selectedPeerId = peer.peerId
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ok: true })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'no-cache-model', messages: [] } }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedPeerId, higher.peerId)
})

test('model-only request routes through a legacy peer-wide service announcement', async () => {
  const peer = makePeer('a', ['openai']) as PeerInfo & { services: string[] }
  peer.services = ['gpt-5.6-terra']
  const proxy = makeBuyerProxyWithPeers([peer], [peer], permissiveRouter())
  let selectedPeerId = ''
  let selectedBody: Record<string, unknown> | null = null
  ;(proxy as any)._node.sendRequest = async (selectedPeer: PeerInfo, request: { requestId: string; body: Uint8Array }) => {
    selectedPeerId = selectedPeer.peerId
    selectedBody = parseJsonBody(request.body)
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ok: true })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    body: { model: 'gpt-56-terra', messages: [] },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedPeerId, peer.peerId)
  assert.equal(selectedBody?.['model'], 'gpt-5.6-terra')
})

test('model-only request routes when the request path has no detectable protocol', async () => {
  const peer = makePeer('a', ['openai'])
  peer.providerServiceApiProtocols = {
    openai: { services: { 'embedding-model': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([peer], [peer], permissiveRouter())
  let selectedBody: Record<string, unknown> | null = null
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string; body: Uint8Array }) => {
    selectedBody = parseJsonBody(request.body)
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/models/custom-operation',
    body: { model: 'embedding-model', input: 'hello' },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedBody?.['model'], 'embedding-model')
})

test('model-only request uses the cheapest duplicate service advertised by one peer', async () => {
  const peer = makePeer('a', ['openai'])
  peer.providerPricing = {
    openai: {
      defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      services: {
        'gpt-5.6-sol': { inputUsdPerMillion: 5, outputUsdPerMillion: 10 },
        'gpt-56-sol': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      },
    },
  }
  peer.providerServiceApiProtocols = {
    openai: {
      services: {
        'gpt-5.6-sol': ['openai-chat-completions'],
        'gpt-56-sol': ['openai-chat-completions'],
      },
    },
  }
  const proxy = makeBuyerProxyWithPeers([peer], [peer], permissiveRouter())
  let selectedBody: Record<string, unknown> | null = null
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string; body: Uint8Array }) => {
    selectedBody = parseJsonBody(request.body)
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ok: true })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    body: { model: 'gpt-5.6-sol', messages: [] },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedBody?.['model'], 'gpt-56-sol')
})

test('antseed alias with a model-only default route uses automatic peer selection', async () => {
  const lower = makePeer('a', ['openai'])
  lower.onChainReputationScore = 40
  lower.providerServiceApiProtocols = {
    openai: { services: { 'gpt-56-sol': ['openai-chat-completions'] } },
  }
  const higher = makePeer('b', ['openai'])
  higher.onChainReputationScore = 90
  higher.providerServiceApiProtocols = {
    openai: { services: { 'openai-gpt-56-sol': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([lower, higher], [lower, higher], permissiveRouter())
  ;(proxy as any)._defaultRoutedModel = 'gpt-5.6-sol'
  let selectedPeerId = ''
  let selectedBody: Record<string, unknown> | null = null
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string; body: Uint8Array }) => {
    selectedPeerId = peer.peerId
    selectedBody = parseJsonBody(request.body)
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ok: true })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'antseed', messages: [] } }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedPeerId, higher.peerId)
  assert.equal(selectedBody?.['model'], 'openai-gpt-56-sol')
})

test('model-only routing skips higher-reputation peers rejected by buyer policy', async () => {
  const allowed = makePeer('a', ['openai'])
  allowed.reputationScore = 60
  allowed.providerServiceApiProtocols = {
    openai: { services: { 'gpt-5': ['openai-chat-completions'] } },
  }
  const rejected = makePeer('b', ['openai'])
  rejected.reputationScore = 95
  rejected.providerServiceApiProtocols = {
    openai: { services: { 'GPT 5': ['openai-chat-completions'] } },
  }
  const router = {
    allowsPeerForPolicy: (_request: unknown, peer: PeerInfo) => peer.peerId === allowed.peerId,
    onResult: () => {},
  }
  const proxy = makeBuyerProxyWithPeers([allowed, rejected], [allowed, rejected], router)
  let selectedPeerId = ''
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    selectedPeerId = peer.peerId
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ ok: true })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'gpt-5', messages: [] } }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedPeerId, allowed.peerId)
})

test('/models order and model-only dispatch use the same Price + Trust ranking', async () => {
  const cobaltRelay = makePeer('a', ['openai'])
  cobaltRelay.onChainReputationScore = 99
  cobaltRelay.providerPricing = {
    openai: { defaults: { inputUsdPerMillion: 1.88, outputUsdPerMillion: 9.38 } },
  }
  cobaltRelay.providerServiceApiProtocols = {
    openai: { services: { 'kimi-k3': ['openai-chat-completions'] } },
  }
  const emberRoute = makePeer('b', ['openai'])
  emberRoute.onChainReputationScore = 96
  emberRoute.providerPricing = {
    openai: { defaults: { inputUsdPerMillion: 0.9, outputUsdPerMillion: 2.7 } },
  }
  emberRoute.providerServiceApiProtocols = {
    openai: { services: { 'Kimi K3': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers(
    [cobaltRelay, emberRoute],
    [cobaltRelay, emberRoute],
    permissiveRouter(),
    undefined,
    priceAndTrustPreferences,
  )
  let selectedPeerId = ''
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    selectedPeerId = peer.peerId
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ peerId: peer.peerId })),
    }
  }

  const modelsRes = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models/kimi-k3' }))
  const peerOrder = (JSON.parse(modelsRes.body) as { peers: Array<{ peerId: string }> }).peers
    .map((peer) => peer.peerId)
  const completionRes = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'kimi-k3', messages: [] } }))

  assert.equal(modelsRes.statusCode, 200)
  assert.deepEqual(peerOrder, [emberRoute.peerId, cobaltRelay.peerId])
  assert.equal(completionRes.statusCode, 200)
  assert.equal(selectedPeerId, emberRoute.peerId)
})

test('Price + Trust routing falls back after the preferred cheaper peer fails', async () => {
  const cobaltRelay = makePeer('a', ['openai'])
  cobaltRelay.onChainReputationScore = 99
  cobaltRelay.providerPricing = {
    openai: { defaults: { inputUsdPerMillion: 1.88, outputUsdPerMillion: 9.38 } },
  }
  cobaltRelay.providerServiceApiProtocols = {
    openai: { services: { 'kimi-k3': ['openai-chat-completions'] } },
  }
  const emberRoute = makePeer('b', ['openai'])
  emberRoute.onChainReputationScore = 96
  emberRoute.providerPricing = {
    openai: { defaults: { inputUsdPerMillion: 0.9, outputUsdPerMillion: 2.7 } },
  }
  emberRoute.providerServiceApiProtocols = {
    openai: { services: { 'Kimi K3': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers(
    [cobaltRelay, emberRoute],
    [cobaltRelay, emberRoute],
    permissiveRouter(),
    undefined,
    priceAndTrustPreferences,
  )
  const attempts: string[] = []
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    attempts.push(peer.peerId)
    return {
      requestId: request.requestId,
      statusCode: peer.peerId === emberRoute.peerId ? 503 : 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ peerId: peer.peerId })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'kimi-k3', messages: [] } }))

  assert.equal(res.statusCode, 200)
  assert.deepEqual(attempts, [emberRoute.peerId, cobaltRelay.peerId])
})

test('model-only routing falls back to the next reputable peer after a retryable failure', async () => {
  const first = makePeer('a', ['openai'])
  first.reputationScore = 95
  first.providerServiceApiProtocols = {
    openai: { services: { 'gpt-5': ['openai-chat-completions'] } },
  }
  const second = makePeer('b', ['openai'])
  second.reputationScore = 80
  second.providerServiceApiProtocols = {
    openai: { services: { 'GPT 5': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([first, second], [first, second], permissiveRouter())
  const attempts: string[] = []
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    attempts.push(peer.peerId)
    return {
      requestId: request.requestId,
      statusCode: peer.peerId === first.peerId ? 503 : 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ peerId: peer.peerId })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'gpt5', messages: [] } }))

  assert.equal(res.statusCode, 200)
  assert.deepEqual(attempts, [first.peerId, second.peerId])
  assert.equal(JSON.parse(res.body).peerId, second.peerId)
})

test('model-only routing retries a rate-limited peer before falling back', async () => {
  const first = makePeer('a', ['openai'])
  first.reputationScore = 95
  first.providerServiceApiProtocols = {
    openai: { services: { 'gpt-5': ['openai-chat-completions'] } },
  }
  const second = makePeer('b', ['openai'])
  second.reputationScore = 80
  second.providerServiceApiProtocols = {
    openai: { services: { 'GPT 5': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([first, second], [first, second], permissiveRouter())
  const attempts: string[] = []
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    attempts.push(peer.peerId)
    const firstAttempts = attempts.filter((peerId) => peerId === first.peerId).length
    const statusCode = peer.peerId === first.peerId && firstAttempts < 3 ? 429 : 200
    return {
      requestId: request.requestId,
      statusCode,
      headers: { 'content-type': 'application/json', 'retry-after': '0' },
      body: Buffer.from(JSON.stringify({ peerId: peer.peerId })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'gpt-5', messages: [] } }))

  assert.equal(res.statusCode, 200)
  assert.deepEqual(attempts, [first.peerId, first.peerId, first.peerId])
})

test('model-only routing falls back after three rate-limit responses from one peer', async () => {
  const first = makePeer('a', ['openai'])
  first.reputationScore = 95
  first.providerServiceApiProtocols = {
    openai: { services: { 'gpt-5': ['openai-chat-completions'] } },
  }
  const second = makePeer('b', ['openai'])
  second.reputationScore = 80
  second.providerServiceApiProtocols = {
    openai: { services: { 'GPT 5': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([first, second], [first, second], permissiveRouter())
  const attempts: string[] = []
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    attempts.push(peer.peerId)
    return {
      requestId: request.requestId,
      statusCode: peer.peerId === first.peerId ? 429 : 200,
      headers: { 'content-type': 'application/json', 'retry-after': '0' },
      body: Buffer.from(JSON.stringify({ peerId: peer.peerId })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'gpt-5', messages: [] } }))

  assert.equal(res.statusCode, 200)
  assert.deepEqual(attempts, [first.peerId, first.peerId, first.peerId, second.peerId])
})

test('model-only routing skips a cooling-down peer when another offer is ready', async () => {
  const clock = makeTestClock()
  const cooling = makePeer('a', ['openai'])
  cooling.reputationScore = 95
  cooling.providerServiceApiProtocols = {
    openai: { services: { 'gpt-5': ['openai-chat-completions'] } },
  }
  const ready = makePeer('b', ['openai'])
  ready.reputationScore = 70
  ready.providerServiceApiProtocols = {
    openai: { services: { 'GPT 5': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([cooling, ready], [cooling, ready], permissiveRouter(), clock.now)
  ;(proxy as any)._peerHealth.set(cooling.peerId, {
    failureStreak: 3,
    windowStartedAt: clock.now(),
    episodeStartedAt: clock.now(),
    cooldownUntil: clock.now() + 60_000,
    lastFailureAt: clock.now(),
    lastSuccessAt: 0,
    lastReason: 'seller-5xx',
  })
  let selectedPeerId = ''
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    selectedPeerId = peer.peerId
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'gpt-5', messages: [] } }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedPeerId, ready.peerId)
})

test('POST /v1/systemone routes only to peers advertising typesafe-systemone', async () => {
  const chatOnly = makePeer('a', ['openai'])
  chatOnly.reputationScore = 95
  chatOnly.providerServiceApiProtocols = {
    openai: { services: { jev: ['openai-chat-completions'] } },
  }
  const decision = makePeer('b', ['openai'])
  decision.reputationScore = 80
  decision.providerServiceApiProtocols = {
    openai: { services: { jev: ['typesafe-systemone'] } },
  }
  const proxy = makeBuyerProxyWithPeers([chatOnly, decision], [chatOnly, decision], permissiveRouter())
  const attempts: string[] = []
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string; path: string }) => {
    attempts.push(peer.peerId)
    assert.equal(request.path, '/v1/systemone')
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ model: 'jev', answers: {}, usage: { input_tokens: 3, output_tokens: 1 } })),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/systemone',
    body: { model: 'jev', state: 'hello', questions: { ok: { type: 'noul', instructions: 'Is it fine?' } } },
  }))

  assert.equal(res.statusCode, 200)
  assert.deepEqual(attempts, [decision.peerId])
})

test('chat requests to a decision-only model get unsupported_protocol, not model_not_found', async () => {
  const decision = makePeer('b', ['typesafe'])
  decision.providerServiceApiProtocols = {
    typesafe: { services: { 'jev-latest': ['typesafe-systemone'] } },
  }
  const proxy = makeBuyerProxyWithPeers([decision], [decision], permissiveRouter())
  let forwarded = 0
  ;(proxy as any)._node.sendRequest = async () => {
    forwarded += 1
    throw new Error('must not reach a peer')
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/chat/completions',
    body: { model: 'jev-latest', messages: [{ role: 'user', content: 'hi' }] },
  }))

  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.equal(body.error.code, 'unsupported_protocol')
  assert.deepEqual(body.error.supported_protocols, ['typesafe-systemone'])
  assert.match(body.error.message, /call POST \/v1\/systemone/)
  assert.equal(forwarded, 0)

  const models = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models?type=decisions' }))
  assert.equal(models.statusCode, 200)
  assert.deepEqual(JSON.parse(models.body).data.map((model: { id: string; type: string }) => [model.id, model.type]), [['jev-latest', 'decision']])
  const text = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models?type=text' }))
  assert.deepEqual(JSON.parse(text.body).data, [])
})

test('model-only routing does not fail over after a buyer-attributed failure', async () => {
  const first = makePeer('a', ['openai'])
  first.reputationScore = 95
  first.providerServiceApiProtocols = {
    openai: { services: { 'gpt-5': ['openai-chat-completions'] } },
  }
  const second = makePeer('b', ['openai'])
  second.reputationScore = 80
  second.providerServiceApiProtocols = {
    openai: { services: { 'GPT 5': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([first, second], [first, second], permissiveRouter())
  const attempts: string[] = []
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo) => {
    attempts.push(peer.peerId)
    throw buyerFault('Buyer has insufficient deposits', 'buyer-deposits-insufficient')
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'gpt-5', messages: [] } }))

  assert.equal(res.statusCode, 503)
  assert.deepEqual(attempts, [first.peerId])
  assert.equal(JSON.parse(res.body).error.code, ANTSEED_BUYER_FAULT_ERROR_CODE)
})

test('pinned proxy request reports when the pinned peer is not discoverable', async () => {
  const pinnedPeerId = 'a'.repeat(40)
  const otherPeer = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([otherPeer])
  const req = makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': pinnedPeerId,
    },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /is not reachable right now/)
  assert.match(res.body, /It may be offline, not announcing, or temporarily unreachable/)
})

test('pinned proxy request surfaces a 403 without failing over to another peer', async () => {
  // An explicit pin is a hard constraint: even with another peer serving the
  // same model, the pinned peer's error is surfaced rather than re-routed.
  const pinnedPeer = makePeer('a', ['openai'])
  pinnedPeer.providerServiceApiProtocols = {
    openai: { services: { 'gpt-5': ['openai-chat-completions'] } },
  }
  const otherPeer = makePeer('b', ['openai'])
  otherPeer.providerServiceApiProtocols = {
    openai: { services: { 'GPT 5': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([pinnedPeer, otherPeer], [pinnedPeer, otherPeer], permissiveRouter())
  const attempts: string[] = []
  ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
    attempts.push(peer.peerId)
    return {
      requestId: request.requestId,
      statusCode: 403,
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<html><body><h1>403 Forbidden</h1></body></html>'),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': pinnedPeer.peerId },
    body: { model: 'gpt-5', messages: [] },
  }))

  assert.equal(res.statusCode, 403)
  assert.deepEqual(attempts, [pinnedPeer.peerId])
})

test('model-only routing fails over to the next peer after a 401 or 403', async () => {
  for (const statusCode of [401, 403]) {
    const first = makePeer('a', ['openai'])
    first.reputationScore = 95
    first.providerServiceApiProtocols = {
      openai: { services: { 'gpt-5': ['openai-chat-completions'] } },
    }
    const second = makePeer('b', ['openai'])
    second.reputationScore = 80
    second.providerServiceApiProtocols = {
      openai: { services: { 'GPT 5': ['openai-chat-completions'] } },
    }
    const proxy = makeBuyerProxyWithPeers([first, second], [first, second], permissiveRouter())
    const attempts: string[] = []
    ;(proxy as any)._node.sendRequest = async (peer: PeerInfo, request: { requestId: string }) => {
      attempts.push(peer.peerId)
      return {
        requestId: request.requestId,
        statusCode: peer.peerId === first.peerId ? statusCode : 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ peerId: peer.peerId })),
      }
    }

    const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'gpt-5', messages: [] } }))

    assert.equal(res.statusCode, 200, `expected failover to succeed for upstream ${statusCode}`)
    assert.deepEqual(attempts, [first.peerId, second.peerId])
    assert.equal(JSON.parse(res.body).peerId, second.peerId)
  }
})

test('pinned proxy request rewrites a canonical alias to the advertised service id', async () => {
  const pinnedPeer = makePeer('a', ['openai'])
  pinnedPeer.providerServiceApiProtocols = {
    openai: { services: { 'gpt-5.6-sol': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([pinnedPeer], [pinnedPeer], permissiveRouter())
  let selectedBody: Record<string, unknown> | null = null
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string; body: Uint8Array }) => {
    selectedBody = parseJsonBody(request.body)
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': pinnedPeer.peerId },
    body: { model: 'gpt-56-sol', messages: [] },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedBody?.['model'], 'gpt-5.6-sol')
})

test('pinned proxy request dispatches when stale metadata misses the requested model', async () => {
  const pinnedPeer = makePeer('a', ['openai'])
  pinnedPeer.providerServiceApiProtocols = {
    openai: { services: { 'known-model': ['openai-chat-completions'] } },
  }
  const proxy = makeBuyerProxyWithPeers([pinnedPeer], [pinnedPeer], permissiveRouter())
  let selectedBody: Record<string, unknown> | null = null
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string; body: Uint8Array }) => {
    selectedBody = parseJsonBody(request.body)
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': pinnedPeer.peerId },
    body: { model: 'new-helper-model', messages: [] },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(selectedBody?.['model'], 'new-helper-model')
})

test('pinned proxy request reports explicit provider mismatch separately', async () => {
  const pinnedPeer = makePeer('a', ['local-llm'])
  const proxy = makeBuyerProxyWithPeers([pinnedPeer])
  const req = makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': pinnedPeer.peerId,
      'x-antseed-provider': 'openai',
    },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /does not offer provider=openai/)
  assert.match(res.body, /Available providers: local-llm/)
  assert.match(res.body, /x-antseed-provider header/)
})

test('pinned proxy request reports protocol or service mismatch when provider is available', async () => {
  const pinnedPeer = makePeer('a', ['local-llm'])
  pinnedPeer.providerServiceApiProtocols = {
    'local-llm': {
      services: {
        llama: ['openai-completions'],
      },
    },
  }
  const proxy = makeBuyerProxyWithPeers([pinnedPeer])
  const req = makeProxyRequest({
    path: '/v1/responses',
    headers: {
      'x-antseed-pin-peer': pinnedPeer.peerId,
      'x-antseed-provider': 'local-llm',
    },
    body: { model: 'llama', input: 'hello' },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /does not support this request/)
  assert.match(res.body, /provider=local-llm/)
  assert.match(res.body, /protocol=openai-responses/)
})

test('pinned proxy request enforces buyer routing policy', async () => {
  const pinnedPeer = makePeer('a', ['openai'])
  const router = {
    allowsPeerForPolicy: () => false,
  }
  const proxy = makeBuyerProxyWithPeers([pinnedPeer], [pinnedPeer], router)
  const req = makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': pinnedPeer.peerId,
    },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.match(res.body, /outside your buyer routing policy/)
  assert.match(res.body, /pricing\/reputation limits/)
})

test('a buyer-attributed failure returns 503 and never blames the peer', async () => {
  const peer = makePeer('a', ['openai'])
  const routerResults: unknown[] = []
  const router = {
    allowsPeerForPolicy: () => true,
    onResult: (_peer: PeerInfo, result: unknown) => {
      routerResults.push(result)
    },
  }
  const proxy = makeBuyerProxyWithPeers([peer], [peer], router)
  ;(proxy as any)._cachedPeers = [peer]
  ;(proxy as any)._node.sendRequest = async () => {
    throw buyerFault(
      'Insufficient buyer deposits for reserve top-up: available=0 required=1000',
      'buyer-deposits-insufficient',
    )
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': peer.peerId,
    },
  }))

  // 503, not 502: our empty deposit is not the seller's fault, and the user
  // should be pointed at the deposit rather than at a different peer.
  assert.equal(res.statusCode, 503)
  assert.equal(JSON.parse(res.body).error.code, ANTSEED_BUYER_FAULT_ERROR_CODE)
  assert.equal(JSON.parse(res.body).error.param, 'buyer-deposits-insufficient')
  assert.equal(res.headers[ANTSEED_FAULT_ATTRIBUTION_HEADER], 'buyer')
  assert.equal(routerResults.length, 0)

  const health = (proxy as any)._peerHealth.get(peer.peerId)
  assert.equal(health?.lastReason, 'buyer-local')
  assert.equal(health?.failureStreak, 0, 'a buyer fault must never build a peer streak')
  assert.equal(health?.cooldownUntil, 0)
  assert.equal((proxy as any)._cachedPeers[0]?.peerId, peer.peerId)
})

test('a buyer-authored 503 does not affect router metrics or peer health', async () => {
  const peer = makePeer('a', ['openai'])
  const routerResults: Array<{ success: boolean }> = []
  const router = {
    allowsPeerForPolicy: () => true,
    onResult: (_peer: PeerInfo, result: { success: boolean }) => {
      routerResults.push(result)
    },
  }
  const proxy = makeBuyerProxyWithPeers([peer], [peer], router)
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => ({
    requestId: request.requestId,
    statusCode: 503,
    headers: {
      'content-type': 'application/json',
      [ANTSEED_FAULT_ATTRIBUTION_HEADER]: 'buyer',
    },
    body: Buffer.from(JSON.stringify({
      error: 'payment_negotiation_failed',
      reason: 'chain_rpc_unavailable',
    })),
  })

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
  }))

  assert.equal(res.statusCode, 503)
  assert.equal(JSON.parse(res.body).error.code, ANTSEED_BUYER_FAULT_ERROR_CODE)
  assert.equal(JSON.parse(res.body).error.param, 'chain_rpc_unavailable')
  assert.equal(routerResults.length, 0)
  const health = healthOf(proxy, peer)
  assert.equal(health?.lastReason, 'buyer-local')
  assert.equal(health?.failureStreak, 0)
  assert.equal(health?.cooldownUntil, 0)
})

test('a pinned seller failure explains the peer boundary and preserves the seller message', async () => {
  const peer = makePeer('a', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer], [peer], permissiveRouter())
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => ({
    requestId: request.requestId,
    statusCode: 503,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      error: {
        type: 'billing_configuration_error',
        message: 'No billing tier matches this request.',
      },
    })),
  })

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
  }))

  const parsed = JSON.parse(res.body) as {
    error: {
      type: string
      message: string
      antseed_fault: string
      antseed_pinned: boolean
      peer_message: string
      peer_status: number
    }
  }
  assert.equal(res.statusCode, 503)
  assert.equal(res.headers[ANTSEED_FAULT_ATTRIBUTION_HEADER], 'peer')
  assert.equal(parsed.error.type, 'billing_configuration_error')
  assert.equal(parsed.error.antseed_fault, 'peer')
  assert.equal(parsed.error.antseed_pinned, true)
  assert.equal(parsed.error.peer_message, 'No billing tier matches this request.')
  assert.equal(parsed.error.peer_status, 503)
  assert.equal(parsed.error.message, [
    'Oops, pinned peer could not complete the request.',
    'Antseed is a peer-to-peer network. Try another peer or use Auto routing.',
    'Original Response: {"message":"No billing tier matches this request.","status":503}',
  ].join('\n'))
})

test('a seller cannot inject the reserved buyer-fault error code', async () => {
  const peer = makePeer('a', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer], [peer], permissiveRouter())
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => ({
    requestId: request.requestId,
    statusCode: 503,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      error: {
        code: ANTSEED_BUYER_FAULT_ERROR_CODE,
        message: `literal ${ANTSEED_BUYER_FAULT_ERROR_CODE}`,
      },
    })),
  })

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: { 'x-antseed-pin-peer': peer.peerId },
  }))

  assert.equal(JSON.parse(res.body).error.code, 'upstream_error')
  assert.match(JSON.parse(res.body).error.message, new RegExp(ANTSEED_BUYER_FAULT_ERROR_CODE))
})

test('an untagged transport failure records a streak without evicting the peer', async () => {
  const peer = makePeer('a', ['openai'])
  const routerResults: Array<{ success: boolean }> = []
  const router = {
    allowsPeerForPolicy: () => true,
    onResult: (_peer: PeerInfo, result: { success: boolean }) => {
      routerResults.push(result)
    },
  }
  const proxy = makeBuyerProxyWithPeers([peer], [peer], router)
  ;(proxy as any)._cachedPeers = [peer]
  ;(proxy as any)._node.sendRequest = async () => {
    throw new Error('Request abc123 timed out')
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': peer.peerId,
    },
  }))

  assert.equal(res.statusCode, 502)
  const parsed = JSON.parse(res.body) as { error: { message: string; peer_message: string } }
  assert.match(parsed.error.message, /Oops, pinned peer could not complete the request/)
  assert.equal(parsed.error.peer_message, 'Request abc123 timed out')
  assert.equal(res.headers[ANTSEED_FAULT_ATTRIBUTION_HEADER], 'peer')
  assert.equal(routerResults.length, 0)
  assert.equal((proxy as any)._peerHealth.get(peer.peerId)?.lastReason, 'request-failed')
  // Cooldown never evicts discovery metadata — the peer stays routable.
  assert.equal((proxy as any)._cachedPeers[0]?.peerId, peer.peerId)
})

test('a timeout does not cool a peer down until another peer proves the buyer is healthy', async () => {
  const clock = makeTestClock()
  const peer = makePeer('a', ['openai'])
  const other = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer, other], [peer, other], permissiveRouter(), clock.now)
  ;(proxy as any)._cachedPeers = [peer, other]
  ;(proxy as any)._node.sendRequest = async () => {
    throw new Error('Request abc123 timed out')
  }

  // No success anywhere yet: the buyer itself might be the broken party, so
  // even three failures must not exile the peer.
  await failRepeatedly(proxy, peer, clock)
  assert.equal(healthOf(proxy, peer)?.cooldownUntil, 0)

  // A different peer answering proves our network, RPC and wallet are fine.
  ;(proxy as any)._rememberSuccessfulPeer(other.peerId)
  await failRepeatedly(proxy, peer, clock)
  assert.ok(
    healthOf(proxy, peer)?.cooldownUntil > clock.now(),
    'with corroboration the peer should now be cooling down',
  )
})

test('a cooling-down peer is still dispatched to when a request names it', async () => {
  const clock = makeTestClock()
  const peer = makePeer('a', ['openai'])
  const other = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer, other], [peer, other], permissiveRouter(), clock.now)
  ;(proxy as any)._cachedPeers = [peer, other]
  ;(proxy as any)._rememberSuccessfulPeer(other.peerId)
  ;(proxy as any)._node.sendRequest = async () => {
    throw new Error('Request abc123 timed out')
  }
  await failRepeatedly(proxy, peer, clock)
  assert.ok(healthOf(proxy, peer)?.cooldownUntil > clock.now())

  let dispatched = false
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => {
    dispatched = true
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ headers: { 'x-antseed-pin-peer': peer.peerId } }))
  assert.equal(dispatched, true, 'cooldown is advisory; a named peer must still be tried')
  assert.equal(res.statusCode, 200)
  // And the response clears the cooldown, because the peer plainly answered.
  assert.equal(healthOf(proxy, peer)?.cooldownUntil, 0)
})

test('a 429 records capacity pressure without ever cooling the peer down', async () => {
  const clock = makeTestClock()
  const peer = makePeer('a', ['openai'])
  const other = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer, other], [peer, other], permissiveRouter(), clock.now)
  ;(proxy as any)._cachedPeers = [peer, other]
  ;(proxy as any)._rememberSuccessfulPeer(other.peerId)
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => ({
    requestId: request.requestId,
    statusCode: 429,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('slow down'),
  })

  await failRepeatedly(proxy, peer, clock, 5)

  const health = healthOf(proxy, peer)
  assert.equal(health?.lastReason, 'seller-busy')
  assert.equal(health?.failureStreak, 0)
  assert.equal(health?.cooldownUntil, 0)
})

test('a seller 503 escalates once the buyer is corroborated as healthy', async () => {
  const clock = makeTestClock()
  const peer = makePeer('a', ['openai'])
  const other = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer, other], [peer, other], permissiveRouter(), clock.now)
  ;(proxy as any)._cachedPeers = [peer, other]
  ;(proxy as any)._rememberSuccessfulPeer(other.peerId)
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => ({
    requestId: request.requestId,
    statusCode: 503,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('seller down'),
  })

  await failRepeatedly(proxy, peer, clock)

  const health = healthOf(proxy, peer)
  assert.equal(health?.lastReason, 'seller-5xx')
  assert.ok(health?.cooldownUntil > clock.now())
})

test('non-standard seller 5xx responses also build a cooldown streak', async () => {
  const clock = makeTestClock()
  const peer = makePeer('a', ['openai'])
  const other = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer, other], [peer, other], permissiveRouter(), clock.now)
  ;(proxy as any)._cachedPeers = [peer, other]
  ;(proxy as any)._rememberSuccessfulPeer(other.peerId)
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => ({
    requestId: request.requestId,
    statusCode: 522,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('connection timed out'),
  })

  await failRepeatedly(proxy, peer, clock)

  const health = healthOf(proxy, peer)
  assert.equal(health?.lastReason, 'seller-5xx')
  assert.ok(health?.cooldownUntil > clock.now())
})

test('a clean 4xx counts as proof of life and clears a cooldown', async () => {
  const clock = makeTestClock()
  const peer = makePeer('a', ['openai'])
  const other = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer, other], [peer, other], permissiveRouter(), clock.now)
  ;(proxy as any)._cachedPeers = [peer, other]
  ;(proxy as any)._rememberSuccessfulPeer(other.peerId)
  ;(proxy as any)._node.sendRequest = async () => {
    throw new Error('Request abc123 timed out')
  }
  await failRepeatedly(proxy, peer, clock)
  assert.ok(healthOf(proxy, peer)?.cooldownUntil > clock.now())

  // A peer that answers 400 to everything is still reachable. Requiring 2xx
  // here would strand a healthy peer in a cooldown it can never escape.
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => ({
    requestId: request.requestId,
    statusCode: 400,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('bad request'),
  })
  await invokeProxy(proxy, makeProxyRequest({ headers: { 'x-antseed-pin-peer': peer.peerId } }))

  const health = healthOf(proxy, peer)
  assert.equal(health?.cooldownUntil, 0)
  assert.equal(health?.failureStreak, 0)
})

test('a non-standard seller 5xx proves reachability and restarts the failure streak', async () => {
  const clock = makeTestClock()
  const peer = makePeer('a', ['openai'])
  const other = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer, other], [peer, other], permissiveRouter(), clock.now)
  ;(proxy as any)._cachedPeers = [peer, other]
  ;(proxy as any)._rememberSuccessfulPeer(other.peerId)
  ;(proxy as any)._node.sendRequest = async () => { throw new Error('Request timed out') }
  await failRepeatedly(proxy, peer, clock)
  assert.ok(healthOf(proxy, peer)?.cooldownUntil > clock.now())

  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => ({
    requestId: request.requestId,
    statusCode: 507,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('insufficient storage'),
  })
  await invokeProxy(proxy, makeProxyRequest({ headers: { 'x-antseed-pin-peer': peer.peerId } }))

  assert.equal(healthOf(proxy, peer)?.cooldownUntil, 0)
  assert.equal(healthOf(proxy, peer)?.failureStreak, 1)
})

function makeNetworkModelPeers(): PeerInfo[] {
  const textPeer = makePeer('a', ['openai'])
  textPeer.providerPricing = {
    openai: {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      services: { 'qwen3-coder': { inputUsdPerMillion: 3, outputUsdPerMillion: 4 } },
    },
  }
  textPeer.providerServiceApiProtocols = {
    openai: { services: { 'qwen3-coder': ['openai-responses'] } },
  }
  textPeer.providerServiceCapabilities = {
    openai: {
      services: {
        'qwen3-coder': {
          contextWindow: 128_000,
          maxOutputTokens: 32_000,
          inputs: ['text', 'image'],
          outputs: ['text'],
          reasoning: true,
          toolUse: true,
          structuredOutput: true,
          supportedParameters: ['temperature', 'tools'],
        },
      },
    },
  }
  textPeer.providerServiceCategories = {
    openai: { services: { 'qwen3-coder': ['chat', 'reasoning'] } },
  }
  const imagePeer = makePeer('b', ['openai'])
  imagePeer.providerServiceApiProtocols = {
    openai: { services: { 'flux-1-schnell': ['openai-images'] } },
  }
  const aliasPeer = makePeer('c', ['anthropic'])
  aliasPeer.providerServiceApiProtocols = {
    anthropic: { services: { 'Claude Opus 5': ['anthropic-messages'] } },
  }
  const secondAliasPeer = makePeer('d', ['anthropic'])
  secondAliasPeer.providerServiceApiProtocols = {
    anthropic: { services: { 'opus-5': ['anthropic-messages'] } },
  }
  return [textPeer, imagePeer, aliasPeer, secondAliasPeer]
}

test('GET /v1/models is answered locally with the network-wide model list', async () => {
  const peers = makeNetworkModelPeers()
  const proxy = makeBuyerProxyWithPeers(peers)
  let forwarded = 0
  ;(proxy as any)._node.sendRequest = async () => {
    forwarded += 1
    throw new Error('must not reach a peer')
  }

  const res = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models' }))
  assert.equal(res.statusCode, 200)
  // The port-reuse probe in `buyer start` identifies the proxy by this header.
  assert.ok(res.headers['x-antseed-request-id'])
  const body = JSON.parse(res.body)
  assert.equal(body.object, 'list')
  assert.deepEqual(body.data.map((model: { id: string }) => model.id), ['Claude Opus 5', 'flux-1-schnell', 'qwen3-coder'])
  const opus = body.data[0]
  assert.equal(opus.name, 'Claude Opus 5')
  assert.deepEqual(opus.peers.map((peer: { serviceId: string }) => peer.serviceId), ['Claude Opus 5', 'opus-5'])
  const flux = body.data[1]
  assert.equal(flux.type, 'image')
  assert.equal(flux.peers[0]?.peerId, peers[1]?.peerId)
  const qwen = body.data[2]
  assert.equal(qwen.name, 'Qwen3 Coder')
  assert.equal(qwen.type, 'text')
  assert.deepEqual(qwen.supported_protocols, ['openai-responses'])
  assert.equal(qwen.context_length, 128_000)
  assert.equal(qwen.max_output_tokens, 32_000)
  assert.deepEqual(qwen.architecture, {
    input_modalities: ['image', 'text'],
    output_modalities: ['text'],
  })
  assert.deepEqual(qwen.capabilities, {
    reasoning: true,
    tool_use: true,
    structured_output: true,
  })
  assert.deepEqual(qwen.supported_parameters, ['temperature', 'tools'])
  assert.equal(qwen.capability_coverage.context_length, 1)
  assert.equal(qwen.peers[0]?.protocol, 'openai-responses')
  assert.deepEqual(qwen.peers[0]?.categories, ['chat', 'reasoning'])
  assert.equal(qwen.peers[0]?.capabilities?.contextWindow, 128_000)
  assert.equal(qwen.peers[0]?.inputUsdPerMillion, 3)
  assert.equal(forwarded, 0)
})

test('GET /v1/models?type= filters by model type and rejects unknown types', async () => {
  const proxy = makeBuyerProxyWithPeers(makeNetworkModelPeers())

  const images = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models?type=images' }))
  assert.equal(images.statusCode, 200)
  assert.deepEqual(JSON.parse(images.body).data.map((model: { id: string }) => model.id), ['flux-1-schnell'])

  const text = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models?type=text' }))
  assert.deepEqual(JSON.parse(text.body).data.map((model: { id: string }) => model.id), ['Claude Opus 5', 'qwen3-coder'])

  const bad = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models?type=audio' }))
  assert.equal(bad.statusCode, 400)
  assert.equal(JSON.parse(bad.body).error.param, 'type')
})

test('GET /v1/models/:id looks up a single model across the network', async () => {
  const proxy = makeBuyerProxyWithPeers(makeNetworkModelPeers())

  const hit = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models/QWEN3-coder' }))
  assert.equal(hit.statusCode, 200)
  const hitBody = JSON.parse(hit.body)
  assert.equal(hitBody.id, 'qwen3-coder')
  assert.equal(hitBody.context_length, 128_000)
  assert.equal(hitBody.peers[0]?.capabilities?.toolUse, true)

  const hitWithIgnoredType = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models/QWEN3-coder?type=audio' }))
  assert.equal(hitWithIgnoredType.statusCode, 200)
  assert.equal(JSON.parse(hitWithIgnoredType.body).id, 'qwen3-coder')

  const aliasHit = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models/opus-5' }))
  assert.equal(aliasHit.statusCode, 200)
  assert.equal(JSON.parse(aliasHit.body).id, 'Claude Opus 5')

  const miss = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models/does-not-exist' }))
  assert.equal(miss.statusCode, 404)
  assert.equal(JSON.parse(miss.body).error.code, 'model_not_found')

  const malformed = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/v1/models/gpt%zz' }))
  assert.equal(malformed.statusCode, 404)
  assert.equal(malformed.headers['content-type'], 'application/json')
  assert.equal(JSON.parse(malformed.body).error.code, 'model_not_found')
})

test('a buyer-side outage rolls back the cooldowns it caused', async () => {
  const clock = makeTestClock()
  const peers = ['a', 'b', 'c', 'd'].map((seed) => makePeer(seed, ['openai']))
  const proxy = makeBuyerProxyWithPeers(peers, peers, permissiveRouter(), clock.now)
  ;(proxy as any)._cachedPeers = peers
  ;(proxy as any)._rememberSuccessfulPeer(peers[3]!.peerId)
  ;(proxy as any)._node.sendRequest = async () => {
    throw new Error('Connection to peer failed')
  }

  // Every peer failing at once is the signature of a dropped network, not of
  // three sellers dying simultaneously.
  for (const peer of peers.slice(0, 3)) {
    await failRepeatedly(proxy, peer!, clock)
  }

  for (const peer of peers.slice(0, 3)) {
    const health = healthOf(proxy, peer!)
    assert.equal(health?.cooldownUntil, 0, `${peer!.peerId.slice(0, 4)} should not be cooling down`)
    assert.equal(health?.failureStreak, 0, `${peer!.peerId.slice(0, 4)} streak should be rolled back`)
  }
})

test('GET /_antseed/peer-health reports cooldowns and buyer health', async () => {
  const clock = makeTestClock()
  const peer = makePeer('a', ['openai'])
  const other = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer, other], [peer, other], permissiveRouter(), clock.now)
  ;(proxy as any)._cachedPeers = [peer, other]
  ;(proxy as any)._rememberSuccessfulPeer(other.peerId)
  ;(proxy as any)._node.sendRequest = async () => {
    throw new Error('Request abc123 timed out')
  }
  await failRepeatedly(proxy, peer, clock)

  const res = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/peer-health' }))
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.buyerHealthy, true)
  const entry = body.peers.find((p: { peerId: string }) => p.peerId === peer.peerId)
  assert.equal(entry.coolingDown, true)
  assert.ok(entry.cooldownMsRemaining > 0)
  assert.equal(entry.lastReason, 'request-failed')
})

test('POST /_antseed/peer-health/clear gives a peer another chance', async () => {
  const clock = makeTestClock()
  const peer = makePeer('a', ['openai'])
  const other = makePeer('b', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer, other], [peer, other], permissiveRouter(), clock.now)
  ;(proxy as any)._cachedPeers = [peer, other]
  ;(proxy as any)._rememberSuccessfulPeer(other.peerId)
  ;(proxy as any)._node.sendRequest = async () => {
    throw new Error('Request abc123 timed out')
  }
  await failRepeatedly(proxy, peer, clock)
  assert.ok(healthOf(proxy, peer)?.cooldownUntil > clock.now())

  const res = await invokeProxy(proxy, makeProxyRequest({
    method: 'POST',
    path: '/_antseed/peer-health/clear',
    body: { peerId: peer.peerId },
  }))
  assert.equal(res.statusCode, 200)
  assert.equal(healthOf(proxy, peer)?.cooldownUntil, 0)
})

test('POST /_antseed/peer-health/clear rejects a malformed peer id', async () => {
  const peer = makePeer('a', ['openai'])
  const proxy = makeBuyerProxyWithPeers([peer], [peer], { allowsPeerForPolicy: () => true })

  const res = await invokeProxy(proxy, makeProxyRequest({
    method: 'POST',
    path: '/_antseed/peer-health/clear',
    body: { peerId: 'nope' },
  }))
  assert.equal(res.statusCode, 400)
})

test('non-stream transformed responses requests force upstream stream without streaming to client', async () => {
  const peer = makePeer('a', ['openai-responses'])
  peer.providerServiceApiProtocols = {
    'openai-responses': {
      services: {
        'gpt-5.6-sol': ['openai-responses'],
      },
    },
  }
  let sendRequestCalls = 0
  let sendRequestStreamCalls = 0
  let capturedRequestBody: Record<string, unknown> | null = null
  let capturedRequestHeaders: Record<string, string> | null = null
  const proxy = makeBuyerProxyWithPeers([peer], [peer])
  ;(proxy as any)._node.sendRequest = async (
    _peer: PeerInfo,
    request: { requestId: string; body: Uint8Array; headers: Record<string, string> },
  ) => {
    sendRequestCalls += 1
    capturedRequestBody = parseJsonBody(request.body)
    capturedRequestHeaders = request.headers
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        id: 'resp_1',
        object: 'response',
        model: 'gpt-5.6-sol',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hi' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })),
    }
  }
  ;(proxy as any)._node.sendRequestStream = async () => {
    sendRequestStreamCalls += 1
    throw new Error('sendRequestStream should not be used')
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/messages',
    headers: {
      'x-antseed-pin-peer': peer.peerId,
    },
    body: {
      model: 'gpt-5.6-sol',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(sendRequestCalls, 1)
  assert.equal(sendRequestStreamCalls, 0)
  assert.equal(capturedRequestBody?.['stream'], true)
  assert.equal(capturedRequestHeaders?.['x-antseed-client-stream-requested'], 'false')
  const body = JSON.parse(res.body) as { content?: Array<{ type: string; text: string }> }
  assert.equal(body.content?.[0]?.text, 'hi')
})

test('accept-sse transformed responses requests stream adapted client events without body stream flag', async () => {
  const peer = makePeer('a', ['openai-responses'])
  peer.providerServiceApiProtocols = {
    'openai-responses': {
      services: {
        'gpt-5.6-sol': ['openai-responses'],
      },
    },
  }
  let sendRequestCalls = 0
  let sendRequestStreamCalls = 0
  let capturedRequestBody: Record<string, unknown> | null = null
  let capturedRequestHeaders: Record<string, string> | null = null
  const proxy = makeBuyerProxyWithPeers([peer], [peer])
  ;(proxy as any)._node.sendRequest = async () => {
    sendRequestCalls += 1
    throw new Error('sendRequest should not be used')
  }
  ;(proxy as any)._node.sendRequestStream = async (
    _peer: PeerInfo,
    request: { requestId: string; body: Uint8Array; headers: Record<string, string> },
    callbacks: {
      onResponseStart: (response: { requestId: string; statusCode: number; headers: Record<string, string>; body: Uint8Array }, metadata: { streaming: boolean }) => void
      onResponseChunk: (chunk: { requestId: string; data: Uint8Array; done: boolean }) => void
    },
  ) => {
    sendRequestStreamCalls += 1
    capturedRequestBody = parseJsonBody(request.body)
    capturedRequestHeaders = request.headers
    callbacks.onResponseStart({
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: new Uint8Array(),
    }, { streaming: true })
    callbacks.onResponseChunk({
      requestId: request.requestId,
      data: Buffer.from(
        'event: response.created\n'
        + 'data: {"type":"response.created","response":{"id":"resp_1","object":"response","model":"gpt-5.6-sol","status":"in_progress","output":[],"output_text":"","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n'
        + 'event: response.output_text.delta\n'
        + 'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"hi","logprobs":[]}\n\n'
        + 'event: response.completed\n'
        + 'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","model":"gpt-5.6-sol","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      ),
      done: false,
    })
    return {
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: Buffer.from(''),
    }
  }

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/messages',
    headers: {
      'accept': 'text/event-stream',
      'x-antseed-pin-peer': peer.peerId,
    },
    body: {
      model: 'gpt-5.6-sol',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    },
  }))

  assert.equal(res.statusCode, 200)
  assert.equal(sendRequestCalls, 0)
  assert.equal(sendRequestStreamCalls, 1)
  assert.equal(capturedRequestBody?.['stream'], true)
  assert.equal(capturedRequestHeaders?.['x-antseed-client-stream-requested'], 'true')
  assert.match(res.body, /event: message_start/)
  assert.match(res.body, /event: content_block_delta/)
  assert.match(res.body, /"text":"hi"/)
  assert.doesNotMatch(res.body, /event: response\.completed/)
})

test('transformed pre-stream seller errors preserve peer guidance', async () => {
  const peer = makePeer('a', ['openai-responses'])
  peer.providerServiceApiProtocols = {
    'openai-responses': {
      services: {
        'gpt-5.6-sol': ['openai-responses'],
      },
    },
  }
  const proxy = makeBuyerProxyWithPeers([peer], [peer])
  ;(proxy as any)._node.sendRequestStream = async (
    _peer: PeerInfo,
    request: { requestId: string },
  ) => ({
    requestId: request.requestId,
    statusCode: 503,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      error: {
        type: 'server_error',
        message: 'The seller upstream is unavailable.',
      },
    })),
  })

  const res = await invokeProxy(proxy, makeProxyRequest({
    path: '/v1/messages',
    headers: {
      accept: 'text/event-stream',
      'x-antseed-pin-peer': peer.peerId,
    },
    body: {
      model: 'gpt-5.6-sol',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    },
  }))

  assert.equal(res.statusCode, 503)
  assert.equal(res.headers[ANTSEED_FAULT_ATTRIBUTION_HEADER], 'peer')
  assert.match(res.headers['content-type'] ?? '', /text\/event-stream/)
  assert.match(res.body, /Oops, pinned peer could not complete the request/)
  assert.match(res.body, /Original Response:.*The seller upstream is unavailable\./)
})

test('model peer prefix pins the request peer and strips the routed model', async () => {
  const pinnedPeer = makePeer('a', ['openai'])
  let capturedRequestBody: Record<string, unknown> | null = null
  let capturedPeerId: string | null = null
  const router = {
    allowsPeerForPolicy: (req: { body: Uint8Array }, peer: PeerInfo) => {
      capturedRequestBody = parseJsonBody(req.body)
      capturedPeerId = peer.peerId
      return false
    },
  }
  const proxy = makeBuyerProxyWithPeers([pinnedPeer], [pinnedPeer], router)
  const req = makeProxyRequest({
    body: { model: `${pinnedPeer.peerId}@gpt-4o`, messages: [] },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.equal(capturedPeerId, pinnedPeer.peerId)
  assert.equal(capturedRequestBody?.['model'], 'gpt-4o')
  assert.equal(capturedRequestBody?.['service'], 'gpt-4o')
})

test('x-antseed-pin-peer header takes precedence over model peer prefix', async () => {
  const modelPinnedPeer = makePeer('a', ['openai'])
  const headerPinnedPeer = makePeer('b', ['openai'])
  let capturedRequestBody: Record<string, unknown> | null = null
  let capturedPeerId: string | null = null
  const router = {
    allowsPeerForPolicy: (req: { body: Uint8Array }, peer: PeerInfo) => {
      capturedRequestBody = parseJsonBody(req.body)
      capturedPeerId = peer.peerId
      return false
    },
  }
  const proxy = makeBuyerProxyWithPeers([modelPinnedPeer, headerPinnedPeer], [modelPinnedPeer, headerPinnedPeer], router)
  const req = makeProxyRequest({
    headers: {
      'x-antseed-pin-peer': headerPinnedPeer.peerId,
    },
    body: { model: `${modelPinnedPeer.peerId}@gpt-4o`, messages: [] },
  })

  const res = await invokeProxy(proxy, req)

  assert.equal(res.statusCode, 502)
  assert.equal(capturedPeerId, headerPinnedPeer.peerId)
  assert.equal(capturedRequestBody?.['model'], 'gpt-4o')
  assert.equal(capturedRequestBody?.['service'], 'gpt-4o')
})

// parsePersistedPeers — hydrates _cachedPeers from buyer.state.json at startup
// so the first request after launch can route from the warm cache without
// blocking on DHT discovery.

const validPeerId = 'a'.repeat(40)
const MAX_AGE_MS = 2 * 60 * 60_000
const NOW = 1_700_000_000_000

test('parsePersistedPeers returns [] for null/undefined/junk input', () => {
  assert.deepEqual(parsePersistedPeers(null, NOW), [])
  assert.deepEqual(parsePersistedPeers(undefined, NOW), [])
  assert.deepEqual(parsePersistedPeers(42, NOW), [])
  assert.deepEqual(parsePersistedPeers('nope', NOW), [])
})

test('parsePersistedPeers returns [] when discoveredPeers is missing or not an array', () => {
  assert.deepEqual(parsePersistedPeers({}, NOW), [])
  assert.deepEqual(parsePersistedPeers({ discoveredPeers: 'oops' }, NOW), [])
  assert.deepEqual(parsePersistedPeers({ discoveredPeers: null }, NOW), [])
})

test('parsePersistedPeers drops entries with invalid peerIds and normalizes case', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        { peerId: 'too-short', providers: [], lastSeen: NOW },
        { peerId: 123, providers: [], lastSeen: NOW },
        { peerId: validPeerId.toUpperCase(), providers: ['openai'], lastSeen: NOW },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 1)
  assert.equal(result[0]?.peerId, validPeerId)
})

test('parsePersistedPeers drops entries with non-array providers', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        { peerId: validPeerId, providers: 'openai', lastSeen: NOW },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 0)
})

test('parsePersistedPeers removes decorative icons from legacy display names', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          displayName: '▲ Example Seller ✅ 🌐',
          providers: ['openai'],
          lastSeen: NOW,
        },
      ],
    },
    NOW,
  )
  assert.equal(result[0]?.displayName, 'Example Seller')
})

test('parsePersistedPeers drops entries with stale or missing freshness anchors', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        { peerId: validPeerId, providers: ['openai'], lastSeen: NOW - MAX_AGE_MS },
        { peerId: 'b'.repeat(40), providers: ['openai'] },
        { peerId: 'c'.repeat(40), providers: ['openai'], lastSeen: 'nope' },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 0)
})

test('parsePersistedPeers keeps peer with stale lastSeen but recent lastReachedAt', () => {
  // A peer whose DHT announcement record aged out but the buyer recently
  // transported a request through is known-alive locally — survive.
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - MAX_AGE_MS - 60_000,
          lastReachedAt: NOW - 60_000,
        },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 1)
  assert.equal(result[0]?.lastReachedAt, NOW - 60_000)
})

test('parsePersistedPeers keeps peer with missing lastSeen but valid lastReachedAt', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          // lastSeen omitted entirely — freshness anchor comes solely from lastReachedAt.
          lastReachedAt: NOW - 10_000,
        },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 1)
  assert.equal(result[0]?.lastReachedAt, NOW - 10_000)
})

test('parsePersistedPeers drops peer when both lastSeen and lastReachedAt are stale', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - MAX_AGE_MS - 1,
          lastReachedAt: NOW - MAX_AGE_MS - 1,
        },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 0)
})

test('parsePersistedPeers preserves provider metadata so routing filters still work', () => {
  const persisted = {
    discoveredPeers: [
      {
        peerId: validPeerId,
        displayName: 'Alice',
        publicAddress: '1.2.3.4:1234',
        providers: ['claude-oauth'],
        capabilities: ['verification.response-auth.v1'],
        services: ['claude-opus-4-6'],
        providerPricing: null,
        providerServiceCategories: null,
        providerServiceApiProtocols: {
          'claude-oauth': {
            services: {
              'claude-opus-4-6': ['anthropic-messages'],
            },
          },
        },
        providerServiceUnitBillingModels: {
          'claude-oauth': {
            services: {
              'claude-opus-4-6': {},
            },
          },
        },
        providerServiceCapabilities: {
          'claude-oauth': {
            services: {
              'claude-opus-4-6': { contextWindow: 200000 },
            },
          },
        },
        defaultInputUsdPerMillion: 3,
        defaultOutputUsdPerMillion: 15,
        maxConcurrency: 4,
        lastSeen: NOW - 5_000,
      },
    ],
  }
  const [peer] = parsePersistedPeers(persisted, NOW)
  assert.ok(peer, 'expected a peer')
  assert.equal(peer!.peerId, validPeerId)
  assert.equal(peer!.displayName, 'Alice')
  assert.equal(peer!.publicAddress, '1.2.3.4:1234')
  assert.deepEqual(peer!.providers, ['claude-oauth'])
  assert.deepEqual(peer!.capabilities, ['verification.response-auth.v1'])
  assert.deepEqual(peer!.metadata?.capabilities, ['verification.response-auth.v1'])
  assert.deepEqual(peer!.providerServiceUnitBillingModels, {
    'claude-oauth': { services: { 'claude-opus-4-6': {} } },
  })
  assert.deepEqual(peer!.providerServiceCapabilities, {
    'claude-oauth': { services: { 'claude-opus-4-6': { contextWindow: 200000 } } },
  })
  assert.equal(peer!.defaultInputUsdPerMillion, 3)
  assert.equal(peer!.defaultOutputUsdPerMillion, 15)
  assert.equal(peer!.maxConcurrency, 4)
  assert.equal(peer!.lastSeen, NOW - 5_000)

  // The hydrated peer should still satisfy the routing filter for its service.
  const result = selectCandidatePeersForRouting(
    [peer!],
    'anthropic-messages',
    'claude-opus-4-6',
    null,
  )
  assert.equal(result.candidatePeers.length, 1)
  assert.equal(result.candidatePeers[0]?.peerId, validPeerId)
  assert.equal(result.routePlanByPeerId.get(validPeerId)?.provider, 'claude-oauth')
})

test('parsePersistedPeers re-derives the trust score from persisted on-chain signals', () => {
  const persisted = {
    discoveredPeers: [
      {
        peerId: validPeerId,
        providers: ['claude-oauth'],
        lastSeen: NOW - 5_000,
        // A stale cached score and breakdown must never win over the signals.
        onChainReputationScore: 3,
        trust: { score: 3, history: null, usage: null, power: null, identity: null, washFlagged: null },
        onChainChannelCount: 20,
        onChainGhostCount: 0,
        onChainTotalVolumeUsdcMicros: 100_000_000,
        onChainLastSettledAtSec: Math.floor((NOW - 60_000) / 1000),
        onChainStakedAtSec: Math.floor((NOW - 40 * 86_400_000) / 1000),
        onChainUsageEpoch: 22,
        onChainUsageShareBps: 1_000,
        onChainUsageLastEpochUsdcMicros: 500_000_000,
        onChainPoolStakeAnts: 1_250.5,
        onChainPoolPowerShareBps: 1_000,
        onChainWashFlagged: false,
        onChainWashShareBps: 0,
      },
    ],
  }

  const [peer] = parsePersistedPeers(persisted, NOW)
  assert.ok(peer)
  assert.equal(peer.onChainUsageEpoch, 22)
  assert.equal(peer.onChainUsageShareBps, 1_000)
  assert.equal(peer.onChainUsageLastEpochUsdcMicros, 500_000_000)
  assert.equal(peer.onChainPoolStakeAnts, 1_250.5)
  assert.equal(peer.onChainPoolPowerShareBps, 1_000)
  assert.equal(peer.onChainWashFlagged, false)
  assert.equal(peer.onChainWashShareBps, 0)
  assert.equal(peer.onChainStakedAtSec, Math.floor((NOW - 40 * 86_400_000) / 1000))
  assert.ok(!('onChainStakeUsdcMicros' in peer))
  assert.ok(!('onChainTrustScore' in peer))
  assert.deepEqual(peer.trust, computeTrustScore(peer, NOW))
  assert.equal(peer.onChainReputationScore, peer.trust?.score)
  // Twenty settled sessions and 100 USDC of volume contribute about 45 history
  // points; 10% usage and power shares add about 17 more.
  assert.equal(Math.round(peer.onChainReputationScore ?? 0), 62)
  assert.equal(peer.trust?.history?.channelCount, 20)
  assert.equal(peer.trust?.history?.totalVolumeUsdcMicros, 100_000_000)
  assert.equal(peer.trust?.usage?.epoch, 21)
  assert.equal(peer.trust?.usage?.shareBps, 1_000)
  assert.equal(peer.trust?.power?.shareBps, 1_000)
  assert.equal(peer.trust?.washFlagged, false)
})

test('parsePersistedPeers scores a proven wash trader at zero regardless of usage', () => {
  const [peer] = parsePersistedPeers({
    discoveredPeers: [{
      peerId: validPeerId,
      providers: ['openai'],
      lastSeen: NOW - 5_000,
      onChainReputationScore: 95,
      onChainUsageEpoch: 22,
      onChainUsageShareBps: 10_000,
      onChainPoolPowerShareBps: 10_000,
      onChainWashFlagged: true,
      onChainWashShareBps: 9_800,
    }],
  }, NOW)
  assert.ok(peer)
  assert.equal(peer.onChainWashFlagged, true)
  assert.equal(peer.onChainWashShareBps, 9_800)
  assert.equal(peer.onChainReputationScore, 0)
  assert.equal(peer.trust?.washFlagged, true)
  assert.equal(peer.trust?.score, 0)
})

test('parsePersistedPeers keeps the persisted score when nothing scoreable was stored', () => {
  const [peer] = parsePersistedPeers({
    discoveredPeers: [{
      peerId: validPeerId,
      providers: ['openai'],
      lastSeen: NOW - 5_000,
      onChainReputationScore: 42,
      onChainChannelCount: 3,
    }],
  }, NOW)
  assert.ok(peer)
  assert.equal(computeTrustScore(peer, NOW), null)
  assert.equal(peer.onChainReputationScore, 42)
  assert.equal(peer.trust, undefined)
})

test('parsePersistedPeers restores sellerContract into peer.metadata', () => {
  // Regression: dropping sellerContract through the persistence layer caused
  // SellerAddressResolver to fall back to peerIdToAddress, so the buyer signed
  // channelId derived from the peer wallet instead of the facade address.
  // On-chain reserve() then reverted with InvalidSignature() because the
  // contract derives channelId from msg.sender (the facade).
  const facade = '1f228613116e2d08014dfdcc198377c8dedf18c9'
  const [peer] = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - 1_000,
          sellerContract: facade,
        },
      ],
    },
    NOW,
  )
  assert.ok(peer)
  assert.equal(peer!.metadata?.sellerContract, facade)
})

test('parsePersistedPeers restores external verification claims and results', () => {
  const verificationResults = {
    identityHistory: { version: 1, identities: [{ kind: 'domain', claim: 'example.com', identityId: 'domain:example.com',
      status: 'available', fetchedAtMs: NOW - 500, createdAtMs: NOW - 10 * 365.25 * 86_400_000 }] },
    verified: true,
    checkedAtMs: NOW - 500,
    domains: [
      {
        domain: 'example.com',
        peerId: validPeerId,
        verified: true,
        method: 'dns-txt',
        checkedAtMs: NOW - 500,
        attempts: [{ method: 'dns-txt', verified: true }],
      },
    ],
    github: [],
  }
  const [peer] = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - 1_000,
          verifications: {
            domains: [{ domain: 'example.com', methods: ['dns-txt'] }],
          },
          verificationResults,
        },
      ],
    },
    NOW,
  )
  assert.ok(peer)
  assert.deepEqual(peer!.metadata?.verifications, {
    domains: [{ domain: 'example.com', methods: ['dns-txt'] }],
  })
  assert.deepEqual(peer!.verificationResults, verificationResults)
  // A ten-year-old verified domain earns the full 12 identity points, worth 20 * 12 / 70 trust.
  assert.equal(peer!.onChainReputationScore, 20 * 12 / 70)
  assert.deepEqual(peer!.trust?.identity, { score: 20 * 12 / 70, kind: 'domain', claim: 'example.com' })
  assert.equal(peer!.trust?.history, null)
  assert.equal(peer!.trust?.usage, null)
  assert.equal(peer!.trust?.washFlagged, null)
  // Ownership proofs and identity evidence expire after seven days: once
  // stale the peer is unscored again rather than keeping the cached score.
  const [stale] = parsePersistedPeers(
    { discoveredPeers: [{ peerId: validPeerId, providers: ['openai'], lastSeen: NOW + 8 * 86_400_000 - 1_000,
      verifications: { domains: [{ domain: 'example.com', methods: ['dns-txt'] }] }, verificationResults }] },
    NOW + 8 * 86_400_000,
  )
  assert.ok(stale)
  assert.equal(computeTrustScore(stale, NOW + 8 * 86_400_000), null)
  assert.equal(stale.onChainReputationScore, undefined)
  assert.equal(stale.trust, undefined)
})

test('parsePersistedPeers restores GitHub identity history but never trusts persisted score breakdowns', () => {
  const stored = { discoveredPeers: [{ peerId: validPeerId, providers: ['openai'], lastSeen: NOW - 1_000,
    verifications: { github: [{ username: 'portfolio', repository: 'proof' }] },
    onChainReputationScore: 100,
    trust: { score: 100, history: { score: 50, channelCount: 100, totalVolumeUsdcMicros: 100_000_000 }, usage: { score: 20, shareBps: 10_000, epoch: 1 }, power: { score: 10, shareBps: 10_000, epoch: 1 }, identity: { score: 20, kind: 'github', claim: 'portfolio' }, washFlagged: false },
    verificationResults: { verified: true, checkedAtMs: NOW - 500, domains: [],
      github: [{ username: 'portfolio', repository: 'proof', peerId: validPeerId, verified: true, checkedAtMs: NOW - 500 }],
      identityHistory: { version: 1, identities: [{ kind: 'github', claim: 'portfolio', identityId: 'github:42', status: 'available',
        fetchedAtMs: NOW - 500, createdAtMs: NOW - 2 * 365.25 * 86_400_000,
        projects: [
          { id: 1, name: 'alpha', createdAtMs: NOW - 365.25 * 86_400_000, stars: 31, archived: false },
          // The ownership-proof repository never counts, however popular.
          { id: 2, name: 'proof', createdAtMs: NOW - 365.25 * 86_400_000, stars: 5_000, archived: false },
        ] }] } },
  }] }
  const [peer] = parsePersistedPeers(JSON.parse(JSON.stringify(stored)), NOW)
  assert.ok(peer)
  assert.equal(peer.verificationResults?.identityHistory?.version, 1)
  assert.equal(peer.verificationResults?.identityHistory?.identities[0]?.projects?.length, 2)
  const trust = computeTrustScore(peer, NOW)
  assert.ok(trust)
  assert.deepEqual(peer.trust, trust)
  assert.equal(peer.onChainReputationScore, trust.score)
  assert.equal(trust.identity?.kind, 'github')
  assert.equal(trust.identity?.claim, 'portfolio')
  assert.equal(trust.usage, null)
  assert.ok(trust.score > 0 && trust.score < 20, `expected a modest identity-only score, got ${trust.score}`)
  const [stale] = parsePersistedPeers(JSON.parse(JSON.stringify(stored)), NOW + 8 * 86_400_000)
  assert.equal(stale, undefined)
})

test('parsePersistedPeers leaves metadata undefined when sellerContract is absent', () => {
  const [peer] = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai'],
          lastSeen: NOW - 1_000,
        },
      ],
    },
    NOW,
  )
  assert.ok(peer)
  assert.equal(peer!.metadata, undefined)
})

test('parsePersistedPeers filters non-string entries out of providers', () => {
  const result = parsePersistedPeers(
    {
      discoveredPeers: [
        {
          peerId: validPeerId,
          providers: ['openai', 42, null, 'claude-oauth'],
          lastSeen: NOW,
        },
      ],
    },
    NOW,
  )
  assert.equal(result.length, 1)
  assert.deepEqual(result[0]?.providers, ['openai', 'claude-oauth'])
})

// peer-pinned model syntax tests

function makeJsonBody(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj))
}

function parseJsonBody(body: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
}

const jsonHeaders: Record<string, string> = { 'content-type': 'application/json' }

test('extractRequestedService reads the model from multipart image edits', () => {
  const boundary = 'image-edit-boundary'
  const body = new TextEncoder().encode([
    `--${boundary}`,
    'Content-Disposition: form-data; name="model"',
    '',
    'gpt-image-2',
    `--${boundary}`,
    'Content-Disposition: form-data; name="image"; filename="source.png"',
    'Content-Type: image/png',
    '',
    'image-bytes',
    `--${boundary}--`,
    '',
  ].join('\r\n'))

  assert.equal(extractRequestedService({
    requestId: 'request-1',
    method: 'POST',
    path: '/v1/images/edits',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  }), 'gpt-image-2')
})

test('parsePeerPinnedService parses 40-char hex peer prefixes', () => {
  assert.deepEqual(parsePeerPinnedService(`${validPeerId}@claude-sonnet-4-5`), {
    peerId: validPeerId,
    service: 'claude-sonnet-4-5',
  })
  assert.deepEqual(parsePeerPinnedService(`0x${validPeerId.toUpperCase()}@gpt-4o`), {
    peerId: validPeerId,
    service: 'gpt-4o',
  })
})

test('parsePeerPinnedService ignores non-peer model paths', () => {
  assert.equal(parsePeerPinnedService('openai/gpt-4o'), null)
  assert.equal(parsePeerPinnedService('openai@gpt-4o'), null)
  assert.equal(parsePeerPinnedService(`${validPeerId}@`), null)
  assert.equal(parsePeerPinnedService(`@${validPeerId}`), null)
})

test('rewritePeerPinnedServiceInBody strips model peer prefix and sets service', () => {
  const body = makeJsonBody({ model: `${validPeerId}@gpt-4o`, messages: [] })
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  const parsed = parseJsonBody(result.body)
  assert.equal(result.pinnedPeerId, validPeerId)
  assert.equal(parsed['service'], 'gpt-4o')
  assert.equal(parsed['model'], 'gpt-4o')
})

test('rewritePeerPinnedServiceInBody strips service peer prefix when model is absent', () => {
  const body = makeJsonBody({ service: `${validPeerId}@gpt-4o`, messages: [] })
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  const parsed = parseJsonBody(result.body)
  assert.equal(result.pinnedPeerId, validPeerId)
  assert.equal(parsed['service'], 'gpt-4o')
  assert.equal(parsed['model'], 'gpt-4o')
})

test('rewritePeerPinnedServiceInBody preserves explicit unprefixed service when model is prefixed', () => {
  const body = makeJsonBody({ model: `${validPeerId}@gpt-4o`, service: 'custom-service', messages: [] })
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  const parsed = parseJsonBody(result.body)
  assert.equal(result.pinnedPeerId, validPeerId)
  assert.equal(parsed['model'], 'gpt-4o')
  assert.equal(parsed['service'], 'custom-service')
})

test('rewritePeerPinnedServiceInBody preserves all other fields', () => {
  const body = makeJsonBody({ model: `${validPeerId}@gpt-4o`, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024 })
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['service'], 'gpt-4o')
  assert.equal(parsed['model'], 'gpt-4o')
  assert.deepEqual(parsed['messages'], [{ role: 'user', content: 'hi' }])
  assert.equal(parsed['max_tokens'], 1024)
})

test('rewritePeerPinnedServiceInBody updates content-length header when present', () => {
  const original = makeJsonBody({ model: `${validPeerId}@gpt-4o`, messages: [] })
  const headers = { 'content-type': 'application/json', 'content-length': String(original.length) }
  const result = rewritePeerPinnedServiceInBody(original, headers)
  assert.equal(result.headers['content-length'], String(result.body.length))
})

test('rewritePeerPinnedServiceInBody returns original when body is not JSON content-type', () => {
  const body = makeJsonBody({ model: `${validPeerId}@gpt-4o` })
  const headers = { 'content-type': 'text/plain' }
  const result = rewritePeerPinnedServiceInBody(body, headers)
  assert.equal(result.body, body)
  assert.equal(result.headers, headers)
  assert.equal(result.pinnedPeerId, null)
})

test('substituteRoutedModelAlias replaces the alias model with the default routed model', () => {
  const body = makeJsonBody({ model: 'antseed', messages: [] })
  const result = substituteRoutedModelAlias(body, jsonHeaders, `${validPeerId}@gpt-4o`)
  assert.equal(result.aliasRequested, true)
  assert.equal(result.substituted, true)
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['model'], `${validPeerId}@gpt-4o`)
})

test('substituteRoutedModelAlias handles the alias in the service field and is case-insensitive', () => {
  const body = makeJsonBody({ service: 'AntSeed', messages: [] })
  const result = substituteRoutedModelAlias(body, jsonHeaders, `${validPeerId}@gpt-4o`)
  assert.equal(result.substituted, true)
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['service'], `${validPeerId}@gpt-4o`)
})

test('substituteRoutedModelAlias reports an unresolvable alias when no default route is set', () => {
  const body = makeJsonBody({ model: 'antseed', messages: [] })
  const result = substituteRoutedModelAlias(body, jsonHeaders, null)
  assert.equal(result.aliasRequested, true)
  assert.equal(result.substituted, false)
  assert.equal(result.body, body)
})

test('substituteRoutedModelAlias leaves non-alias models untouched', () => {
  const body = makeJsonBody({ model: 'gpt-4o', messages: [] })
  const result = substituteRoutedModelAlias(body, jsonHeaders, `${validPeerId}@gpt-4o`)
  assert.equal(result.aliasRequested, false)
  assert.equal(result.substituted, false)
  assert.equal(result.body, body)
})

test('overrideRoutedModelInBody swaps the model, mirrors an identical service field, and fixes content-length', () => {
  const oldRoute = `${validPeerId}@gpt-4o`
  const newRoute = `${'bb'.repeat(20)}@glm-5`
  const body = makeJsonBody({ model: oldRoute, service: oldRoute, messages: [] })
  const headers = { ...jsonHeaders, 'content-length': String(body.length) }
  const result = overrideRoutedModelInBody(body, headers, newRoute)
  assert.equal(result.overridden, true)
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['model'], newRoute)
  assert.equal(parsed['service'], newRoute)
  assert.equal(result.headers['content-length'], String(result.body.length))
})

test('overrideRoutedModelInBody leaves a differing service field alone', () => {
  const body = makeJsonBody({ model: `${validPeerId}@gpt-4o`, service: 'something-else', messages: [] })
  const result = overrideRoutedModelInBody(body, jsonHeaders, `${'bb'.repeat(20)}@glm-5`)
  assert.equal(result.overridden, true)
  const parsed = parseJsonBody(result.body)
  assert.equal(parsed['model'], `${'bb'.repeat(20)}@glm-5`)
  assert.equal(parsed['service'], 'something-else')
})

test('overrideRoutedModelInBody no-ops on a matching model, a missing model, or non-JSON bodies', () => {
  const route = `${validPeerId}@gpt-4o`
  const matching = makeJsonBody({ model: route })
  assert.equal(overrideRoutedModelInBody(matching, jsonHeaders, route).overridden, false)
  const missing = makeJsonBody({ messages: [] })
  assert.equal(overrideRoutedModelInBody(missing, jsonHeaders, route).overridden, false)
  const nonJson = makeJsonBody({ model: 'other' })
  assert.equal(overrideRoutedModelInBody(nonJson, { 'content-type': 'text/plain' }, route).overridden, false)
})

test('route control endpoint sets, persists, and returns the default routed model', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-route-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: dir,
    node: { router: null } as any,
  })

  const set = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/route', body: { model: `${validPeerId}@gpt-4o` } }))
  assert.equal(set.statusCode, 200)
  assert.deepEqual(JSON.parse(set.body), { ok: true, model: `${validPeerId}@gpt-4o` })

  const get = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/route' }))
  assert.deepEqual(JSON.parse(get.body), { ok: true, model: `${validPeerId}@gpt-4o` })

  const persisted = JSON.parse(await readFile(join(dir, 'buyer.state.json'), 'utf-8')) as Record<string, unknown>
  assert.equal(persisted['defaultRoutedModel'], `${validPeerId}@gpt-4o`)

  const automatic = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/route', body: { model: 'gpt-4o' } }))
  assert.equal(automatic.statusCode, 200)
  assert.deepEqual(JSON.parse(automatic.body), { ok: true, model: 'gpt-4o' })

  const automaticPersisted = JSON.parse(await readFile(join(dir, 'buyer.state.json'), 'utf-8')) as Record<string, unknown>
  assert.equal(automaticPersisted['defaultRoutedModel'], 'gpt-4o')

  const invalid = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/route', body: { model: 'not-a-peer@gpt-4o' } }))
  assert.equal(invalid.statusCode, 400)

  const cleared = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/route', body: { model: '' } }))
  assert.deepEqual(JSON.parse(cleared.body), { ok: true, model: null })
})

test('buyer-usage endpoint reports lastActivityAt, null until a request is dispatched', async () => {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null, getBuyerUsageTotals: () => ({ totalRequests: 0 }) } as any,
  })

  const before = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/buyer-usage' }))
  assert.equal(before.statusCode, 200)
  assert.equal((JSON.parse(before.body) as { lastActivityAt: number | null }).lastActivityAt, null)

  ;(proxy as any)._markModelActivity()

  const after = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/buyer-usage' }))
  const parsed = JSON.parse(after.body) as { ok: boolean; lastActivityAt: number | null }
  assert.equal(parsed.ok, true)
  assert.equal(typeof parsed.lastActivityAt, 'number')
  assert.ok((parsed.lastActivityAt ?? 0) > 0)
})

test('requests with the routed-model alias fail clearly when no default route is set', async () => {
  const proxy = makeBuyerProxyWithPeers([makePeer('a', ['openai'])])

  const res = await invokeProxy(proxy, makeProxyRequest({ body: { model: 'antseed', messages: [] } }))
  assert.equal(res.statusCode, 400)
  const parsed = JSON.parse(res.body) as { error?: { code?: string } }
  assert.equal(parsed.error?.code, 'no_default_route')
})

test('substituteRoutedModelAlias updates content-length when substituting', () => {
  const original = makeJsonBody({ model: 'antseed', messages: [] })
  const headers = { 'content-type': 'application/json', 'content-length': String(original.length) }
  const result = substituteRoutedModelAlias(original, headers, `${validPeerId}@gpt-4o`)
  assert.equal(result.headers['content-length'], String(result.body.length))
})

test('rewritePeerPinnedServiceInBody returns original when body is empty', () => {
  const body = new Uint8Array(0)
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  assert.equal(result.body, body)
  assert.equal(result.pinnedPeerId, null)
})

test('rewritePeerPinnedServiceInBody returns original when body is not a JSON object', () => {
  const body = new TextEncoder().encode('"just a string"')
  const result = rewritePeerPinnedServiceInBody(body, jsonHeaders)
  assert.equal(result.body, body)
  assert.equal(result.pinnedPeerId, null)
})

// ---------- Per-chat conversations (tracking, pins, control endpoints) ----------

async function makeConversationProxy(): Promise<{ proxy: BuyerProxy; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-conv-'))
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: dir,
    node: { router: null } as any,
  })
  ;(proxy as any)._getPeers = async () => []
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  return { proxy, dir }
}

test('per-chat pin overrides the default routed model for the antseed alias', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    const defaultRoute = `${'aa'.repeat(20)}@default-model`
    const pinnedRoute = `${'bb'.repeat(20)}@pinned-model`
    ;(proxy as any)._defaultRoutedModel = defaultRoute
    const store = (proxy as any)._conversations
    store.touch({ tool: 'codex-exec', sessionKey: 'sess-1' })
    store.setPinnedModel('codex-exec:sess-1', pinnedRoute, 'user')

    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: { originator: 'codex_exec', 'session-id': 'sess-1' },
      body: {
        model: 'antseed',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello there' }] }],
      },
    }))

    // Routing itself fails (no peers), but the pin was applied during alias
    // substitution and recorded as the conversation's resolved model.
    const record = store.get('codex-exec:sess-1')
    assert.equal(record?.lastModel, pinnedRoute)

    // A different chat without a pin resolves to the default route.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: { originator: 'codex_exec', 'session-id': 'sess-2' },
      body: {
        model: 'antseed',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second chat' }] }],
      },
    }))
    const second = store.get('codex-exec:sess-2')
    assert.equal(second?.lastModel, defaultRoute)
    assert.equal(second?.snippet, 'second chat')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chat pin overrides a system-proxy-routed model on intercepted requests', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    const proxyRoute = `${'aa'.repeat(20)}@default-model`
    const pinnedRoute = `${'bb'.repeat(20)}@pinned-model`
    const store = (proxy as any)._conversations

    // First intercepted request: the system proxy already rewrote the tool's
    // upstream model to its connect-time route and marked the request. The
    // chat auto-pins to the model that served it.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages',
      headers: { 'x-claude-code-session-id': 'cc-1', [SYSTEM_ROUTED_MODEL_HEADER]: '1' },
      body: { model: proxyRoute, messages: [{ role: 'user', content: 'hello there' }] },
    }))
    assert.equal(store.get('claude-code:cc-1')?.pinnedModel, proxyRoute)

    // The user re-pins the chat from the desktop (float / chats view).
    store.setPinnedModel('claude-code:cc-1', pinnedRoute, 'user')

    // Later requests still arrive with the proxy-assigned model; the pin wins.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages',
      headers: { 'x-claude-code-session-id': 'cc-1', [SYSTEM_ROUTED_MODEL_HEADER]: '1' },
      body: { model: proxyRoute, messages: [{ role: 'user', content: 'again' }] },
    }))
    assert.equal(store.get('claude-code:cc-1')?.lastModel, pinnedRoute)

    // Without the marker the model is a client choice and is respected.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages',
      headers: { 'x-claude-code-session-id': 'cc-1' },
      body: { model: proxyRoute, messages: [{ role: 'user', content: 'explicit' }] },
    }))
    assert.equal(store.get('claude-code:cc-1')?.lastModel, proxyRoute)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('count_tokens is answered locally and never reaches a seller', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    let routed = 0
    ;(proxy as any)._getPeers = async () => { routed += 1; return [] }

    const res = await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages/count_tokens',
      headers: { 'x-claude-code-session-id': 'cc-count' },
      body: {
        model: 'claude-sonnet-4-5',
        system: 'You are a CLI assistant. '.repeat(40),
        messages: [{ role: 'user', content: 'how big is this conversation?' }],
      },
    }))

    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body) as { input_tokens: number }
    assert.ok(body.input_tokens > 50, `expected a token count, got ${JSON.stringify(body)}`)
    assert.equal(routed, 0, 'count_tokens must not route to a peer')
    // It is a probe about a chat, not a turn in one.
    assert.deepEqual((proxy as any)._conversations.list(), [])
    await (proxy as any)._conversations.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a thread the tool opened for itself never becomes a chat', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    const store = (proxy as any)._conversations
    const turnMetadata = (threadId: string, threadSource: string): string =>
      JSON.stringify({ thread_id: threadId, request_kind: 'turn', thread_source: threadSource })

    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: {
        originator: 'Codex Desktop',
        'thread-id': 'thread-real',
        'x-codex-turn-metadata': turnMetadata('thread-real', 'user'),
      },
      body: { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'yo' }] }] },
    }))

    // Codex titles the chat from a system thread of its own, milliseconds later.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/responses',
      headers: {
        originator: 'Codex Desktop',
        'thread-id': 'thread-title',
        'x-codex-turn-metadata': turnMetadata('thread-title', 'system'),
      },
      body: { input: 'You are a helpful assistant... provide a short title...\n\nUser prompt:\nyo' },
    }))

    assert.deepEqual(store.list().map((c: any) => c.id), ['codex-desktop:thread-real'])
    assert.equal(store.get('codex-desktop:thread-real')?.snippet, 'yo')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('conversation control endpoints list, rename, pin, reject bad pins, delete', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    const store = (proxy as any)._conversations
    store.touch({ tool: 'opencode', sessionKey: 'ses_x', snippet: 'refactor the login flow' })

    const list = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/conversations' }))
    assert.equal(list.statusCode, 200)
    const listed = JSON.parse(list.body) as { ok: boolean; conversations: Array<{ id: string; snippet: string }> }
    assert.equal(listed.ok, true)
    assert.equal(listed.conversations.length, 1)
    assert.equal(listed.conversations[0]?.id, 'opencode:ses_x')

    const rename = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'opencode:ses_x', label: 'Login refactor' },
    }))
    assert.equal(rename.statusCode, 200)
    assert.equal(store.get('opencode:ses_x')?.label, 'Login refactor')

    const automaticPin = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'opencode:ses_x', pinnedModel: 'gpt-5.6-sol', peerSource: 'auto' },
    }))
    assert.equal(automaticPin.statusCode, 200)
    assert.equal(store.getPinnedModel('opencode', 'ses_x'), 'gpt-5.6-sol')

    const badPin = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'opencode:ses_x', pinnedModel: 'not-a-peer@gpt-5.6-sol' },
    }))
    assert.equal(badPin.statusCode, 400)

    const goodPin = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'opencode:ses_x', pinnedModel: `${'cc'.repeat(20)}@glm-5` },
    }))
    assert.equal(goodPin.statusCode, 200)
    assert.equal(store.getPinnedModel('opencode', 'ses_x'), `${'cc'.repeat(20)}@glm-5`)

    const clearPin = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'opencode:ses_x', pinnedModel: '' },
    }))
    assert.equal(clearPin.statusCode, 200)
    assert.equal(store.getPinnedModel('opencode', 'ses_x'), null)

    const missing = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'nope:missing', label: 'x' },
    }))
    assert.equal(missing.statusCode, 404)

    const removed = await invokeProxy(proxy, makeProxyRequest({
      path: '/_antseed/conversations/update',
      body: { id: 'opencode:ses_x', delete: true },
    }))
    assert.equal(removed.statusCode, 200)
    assert.equal(store.get('opencode:ses_x'), null)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('subagent requests roll up into the parent conversation', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    ;(proxy as any)._defaultRoutedModel = `${'aa'.repeat(20)}@default-model`
    const store = (proxy as any)._conversations

    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'opencode/1.0', 'x-session-id': 'ses_child', 'x-parent-session-id': 'ses_parent' },
      body: { model: 'antseed', messages: [{ role: 'user', content: 'subtask prompt' }] },
    }))

    assert.equal(store.get('opencode:ses_child'), null)
    assert.notEqual(store.get('opencode:ses_parent'), null)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('title request racing ahead of the first turn does not name the chat', async () => {
  const { proxy, dir } = await makeConversationProxy()
  try {
    ;(proxy as any)._defaultRoutedModel = `${'aa'.repeat(20)}@default-model`
    const store = (proxy as any)._conversations

    // OpenCode's ensureTitle request lands first, on the same session.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/chat/completions',
      headers: { 'user-agent': 'opencode/1.0', 'x-session-id': 'ses_race' },
      body: {
        model: 'antseed',
        messages: [
          { role: 'user', content: 'Generate a title for this conversation:\n' },
          { role: 'user', content: 'hi' },
        ],
      },
    }))
    // Title-only housekeeping routes normally but no longer creates the row.
    assert.equal(store.get('opencode:ses_race'), null)

    // A Claude/T3 Code-style pure title request routes normally but does not
    // create a blank conversation row.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages',
      headers: { 'user-agent': 'claude-cli/2.0 (external)', 'x-claude-code-session-id': 'cc_race' },
      body: {
        model: 'antseed',
        messages: [{ role: 'user', content: 'You write concise thread titles for a coding chat.' }],
      },
    }))
    assert.equal(store.get('claude-code:cc_race'), null)

    // Factory/Droid has no session header. Its main turn and concurrent
    // one-shot title request therefore hash to different synthetic keys. The
    // system-role title instruction must keep the second key out of the list.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/chat/completions',
      headers: { originator: 'droid', 'user-agent': 'factory-cli/0.202.0' },
      body: {
        model: 'antseed',
        messages: [
          { role: 'system', content: 'You are Droid, an AI software engineering agent.' },
          { role: 'user', content: 'wowow' },
        ],
      },
    }))
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/chat/completions',
      headers: {
        originator: 'droid',
        'user-agent': 'factory-cli/0.202.0',
      },
      body: {
        model: 'antseed',
        messages: [
          {
            role: 'system',
            content: `Shared provider compatibility preamble.
You are a helper that generates concise session titles for a session picker.
Input: one user message from the start of a session.`,
          },
          { role: 'user', content: 'wowow' },
        ],
      },
    }))
    assert.equal(store.list().filter((conversation: any) => conversation.tool === 'droid').length, 1)

    // The exact helper marker describes housekeeping regardless of which
    // integration sends it, so it does not create another conversation row.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/chat/completions',
      headers: { originator: 'other-agent', 'user-agent': 'other-agent/1.0' },
      body: {
        model: 'antseed',
        messages: [
          {
            role: 'system',
            content: `Shared provider compatibility preamble.
You are a helper that generates concise session titles for a session picker.
Input: one user message from the start of a session.`,
          },
          { role: 'user', content: 'wowow' },
        ],
      },
    }))
    assert.equal(store.list().filter((conversation: any) => conversation.tool === 'other-agent').length, 0)

    // The real first turn creates the conversation afterwards.
    await invokeProxy(proxy, makeProxyRequest({
      path: '/v1/messages',
      headers: { 'user-agent': 'claude-cli/2.0 (external)', 'x-claude-code-session-id': 'cc_race' },
      body: {
        model: 'antseed',
        messages: [{ role: 'user', content: 'fix the login bug' }],
      },
    }))
    assert.equal(store.get('claude-code:cc_race')?.snippet, 'fix the login bug')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('makeVerifierReach: rejects non-attest paths, sends the attest route as a payment-free control-plane request', async () => {
  const peer = makePeer('a', ['openai'])
  const signal = new AbortController().signal

  const rejectNode = { sendRequest: async () => ({ statusCode: 200, headers: {}, body: new Uint8Array() }) }
  await assert.rejects(
    makeVerifierReach(rejectNode as never, peer, 'antseed-verifier', signal)({ method: 'POST', path: '/v1/chat/completions' }),
    /may only call its attestation route/,
  )

  let opts: Record<string, unknown> | undefined
  const captureNode = {
    sendRequest: async (_peer: unknown, _req: unknown, o: Record<string, unknown>) => {
      opts = o
      return { statusCode: 200, headers: {}, body: new Uint8Array() }
    },
  }
  const resp = await makeVerifierReach(captureNode as never, peer, 'antseed-verifier', signal)(
    { method: 'POST', path: '/_antseed/attest/antseed-verifier', body: new Uint8Array([1]) },
  )
  assert.equal(resp.statusCode, 200)
  assert.equal(opts!.controlPlane, true)
  assert.equal(opts!.signal, signal)
})

test('isModelNotFoundResponse: detects seller and upstream model_not_found rejections', () => {
  const makeResponse = (statusCode: number, body: unknown): SerializedHttpResponse => ({
    requestId: 'r1',
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? new TextEncoder().encode(body) : new TextEncoder().encode(JSON.stringify(body)),
  })

  // Seller-side pre-payment rejection (seller-request-handler shape).
  assert.equal(isModelNotFoundResponse(makeResponse(400, {
    error: { message: 'Service "x" is not served by this peer.', type: 'invalid_request_error', code: 'model_not_found' },
  })), true)
  // Upstream 404 pass-through with the same code.
  assert.equal(isModelNotFoundResponse(makeResponse(404, {
    error: { message: 'The model does not exist', type: 'invalid_request_error', code: 'model_not_found' },
  })), true)

  // Other 400s must not be misclassified.
  assert.equal(isModelNotFoundResponse(makeResponse(400, {
    error: { message: 'Missing model field', type: 'invalid_request_error', code: 'model_required' },
  })), false)
  assert.equal(isModelNotFoundResponse(makeResponse(400, 'not json')), false)
  assert.equal(isModelNotFoundResponse(makeResponse(200, { ok: true })), false)
  assert.equal(isModelNotFoundResponse(makeResponse(500, {
    error: { code: 'model_not_found' },
  })), false)
})

test('mergeJsonStateFile: merges into existing state and leaves no temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-state-'))
  try {
    const stateFile = join(dir, 'buyer.state.json')
    await mergeJsonStateFile(dir, stateFile, { a: 1, pinnedPeerId: 'old' })
    await mergeJsonStateFile(dir, stateFile, { pinnedPeerId: 'new', b: 2 })
    const state = JSON.parse(await readFile(stateFile, 'utf-8')) as Record<string, unknown>
    assert.deepEqual(state, { a: 1, pinnedPeerId: 'new', b: 2 })
    const tmpLeftovers = (await readdir(dir)).filter((name) => name.endsWith('.json.tmp'))
    assert.deepEqual(tmpLeftovers, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeJsonStateFile: unlinks the temp file when the rename fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-state-'))
  try {
    // A directory at the state-file path makes rename() fail on every platform
    // with a non-retryable code, exercising the cleanup path.
    const stateFile = join(dir, 'buyer.state.json')
    await mkdir(stateFile)
    await assert.rejects(mergeJsonStateFile(dir, stateFile, { a: 1 }))
    const tmpLeftovers = (await readdir(dir)).filter((name) => name.endsWith('.json.tmp'))
    assert.deepEqual(tmpLeftovers, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sweepStaleStateTmpFiles: removes aged temp files, keeps fresh and unrelated ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-state-'))
  try {
    const stale = join(dir, '.buyer.state.11111111-1111-1111-1111-111111111111.json.tmp')
    const fresh = join(dir, '.buyer.state.22222222-2222-2222-2222-222222222222.json.tmp')
    const unrelated = join(dir, 'buyer.state.json')
    await writeFile(stale, '{}')
    await writeFile(fresh, '{}')
    await writeFile(unrelated, '{}')
    const past = new Date(Date.now() - 5 * 60_000)
    await utimes(stale, past, past)

    await sweepStaleStateTmpFiles(dir)

    const remaining = (await readdir(dir)).sort()
    assert.deepEqual(remaining, [
      '.buyer.state.22222222-2222-2222-2222-222222222222.json.tmp',
      'buyer.state.json',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sweepStaleStateTmpFiles: tolerates a missing directory', async () => {
  await sweepStaleStateTmpFiles(join(tmpdir(), 'antseed-does-not-exist', randomUUID()))
})

// ---------- Deposit watcher control plane ----------

test('deposits/status reports no watcher until one is attached', async () => {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null } as any,
  })

  const res = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/deposits/status' }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, watcher: false, reason: null, payments: null, status: null })
})

test('sanitizePeerBuyerFaultMarker scrubs the marker at any nesting depth', () => {
  let deeplyNested: Record<string, unknown> = {
    code: ANTSEED_BUYER_FAULT_ERROR_CODE,
    message: 'seller-controlled message',
  }
  for (let depth = 0; depth < 20; depth += 1) {
    deeplyNested = { inner: deeplyNested }
  }
  const body = {
    error: {
      type: 'server_error',
      details: {
        code: ANTSEED_BUYER_FAULT_ERROR_CODE,
        inner: [{ errorCode: ANTSEED_BUYER_FAULT_ERROR_CODE }, deeplyNested],
      },
    },
  }
  const sanitized = sanitizePeerBuyerFaultMarker({
    requestId: 'r1',
    statusCode: 503,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  })

  const parsed = JSON.parse(Buffer.from(sanitized.body).toString('utf-8')) as typeof body
  assert.equal(parsed.error.details.code, 'upstream_error')
  assert.equal((parsed.error.details.inner[0] as { errorCode: string }).errorCode, 'upstream_error')
  let nested = parsed.error.details.inner[1] as Record<string, unknown>
  for (let depth = 0; depth < 20; depth += 1) {
    nested = nested.inner as Record<string, unknown>
  }
  assert.equal(nested.code, 'upstream_error')
  assert.equal(nested.message, 'seller-controlled message')
})

test('adaptPeerFaultErrorResponse leaves actionable request errors unchanged', () => {
  const body = Buffer.from(JSON.stringify({
    error: { type: 'invalid_request_error', message: 'The prompt is too long.' },
  }))
  const response = adaptPeerFaultErrorResponse({
    requestId: 'req-actionable',
    statusCode: 400,
    headers: { 'content-type': 'application/json' },
    body,
  }, 'openai-chat-completions')

  assert.equal(Buffer.from(response.body).toString('utf8'), body.toString('utf8'))
  assert.equal(response.headers[ANTSEED_FAULT_ATTRIBUTION_HEADER], 'peer')
})

test('adaptPeerFaultErrorResponse upgrades a generic wrapper for a pinned route', () => {
  const raw = {
    requestId: 'req-pinned-upgrade',
    statusCode: 429,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: 'Insufficient balance or no resource package. Please recharge.',
      },
    })),
  }
  const generic = adaptPeerFaultErrorResponse(raw, 'openai-chat-completions')
  const pinned = adaptPeerFaultErrorResponse(generic, 'openai-chat-completions', { pinned: true })
  const parsed = JSON.parse(Buffer.from(pinned.body).toString('utf8')) as {
    error: { message: string; antseed_pinned: boolean; peer_message: string; peer_status: number }
  }

  assert.equal(parsed.error.antseed_pinned, true)
  assert.equal(parsed.error.peer_message, 'Insufficient balance or no resource package. Please recharge.')
  assert.equal(parsed.error.peer_status, 429)
  assert.equal(parsed.error.message, [
    'Oops, pinned peer could not complete the request.',
    'Antseed is a peer-to-peer network. Try another peer or use Auto routing.',
    'Original Response: {"message":"Insufficient balance or no resource package. Please recharge.","status":429}',
  ].join('\n'))
})

test('adaptPeerFaultErrorResponse preserves payment-required control messages', () => {
  const body = Buffer.from(JSON.stringify({
    error: 'payment_required',
    minBudgetPerRequest: '1000',
  }))
  const response = adaptPeerFaultErrorResponse({
    requestId: 'req-payment',
    statusCode: 402,
    headers: { 'content-type': 'application/json' },
    body,
  }, 'openai-chat-completions')

  assert.equal(Buffer.from(response.body).toString('utf8'), body.toString('utf8'))
  assert.equal(response.headers[ANTSEED_FAULT_ATTRIBUTION_HEADER], undefined)
})

test('deposits/status reports the recorded watcher-absence reason and payments health', async () => {
  const paymentsStatus = {
    configured: true,
    buyerActive: true,
    sellerActive: false,
    chainId: 8453,
    rpc: { state: 'unreachable', lastCheckedAt: 123, lastReadyAt: null, lastError: 'probe failed', attempts: 2 },
  }
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null, getPaymentsStatus: () => paymentsStatus } as any,
  })
  proxy.setDepositWatcher(null, 'payments-disabled')

  const res = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/deposits/status' }))
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body) as { watcher: boolean; reason: string | null; payments: unknown }
  assert.equal(body.watcher, false)
  assert.equal(body.reason, 'payments-disabled')
  assert.deepEqual(body.payments, paymentsStatus)

  const watchRes = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/deposits/watch', body: { mode: 'active' } }))
  assert.equal(watchRes.statusCode, 503)
  const watchBody = JSON.parse(watchRes.body) as { ok: boolean; reason: string | null; error: string }
  assert.equal(watchBody.ok, false)
  assert.equal(watchBody.reason, 'payments-disabled')
  assert.match(watchBody.error, /payments are disabled/)
})

test('deposits/watch returns 503 when no watcher is attached', async () => {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null } as any,
  })

  const res = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/deposits/watch', body: { mode: 'active' } }))
  assert.equal(res.statusCode, 503)
  assert.equal((JSON.parse(res.body) as { ok: boolean }).ok, false)
})

test('deposits/watch promotes and demotes an attached watcher and returns its status', async () => {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null } as any,
  })
  const calls: string[] = []
  const fakeStatus = {
    mode: 'idle',
    address: '0x' + 'ab'.repeat(20),
    usdcBalance: '0',
    sweepInFlight: false,
    lastEvent: null,
  }
  proxy.setDepositWatcher({
    promote: () => { calls.push('promote') },
    demote: () => { calls.push('demote') },
    status: () => fakeStatus,
  } as any)

  const active = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/deposits/watch', body: { mode: 'active' } }))
  assert.equal(active.statusCode, 200)
  assert.deepEqual(JSON.parse(active.body), { ok: true, status: fakeStatus })

  const background = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/deposits/watch', body: { mode: 'background' } }))
  assert.equal(background.statusCode, 200)
  assert.deepEqual(calls, ['promote', 'demote'])

  const invalid = await invokeProxy(proxy, makeProxyRequest({ path: '/_antseed/deposits/watch', body: { mode: 'nonsense' } }))
  assert.equal(invalid.statusCode, 400)
  assert.deepEqual(calls, ['promote', 'demote'])

  const status = await invokeProxy(proxy, makeProxyRequest({ method: 'GET', path: '/_antseed/deposits/status' }))
  assert.deepEqual(JSON.parse(status.body), { ok: true, watcher: true, reason: null, payments: null, status: fakeStatus })
})

test('getSweepReceipt returns cached relayer receipts case-insensitively', () => {
  const proxy = new BuyerProxy({
    port: 0,
    dataDir: '/tmp/antseed-test',
    node: { router: null } as any,
  })
  const nonce = '0x' + 'AB'.repeat(32)
  const receipt = { authNonce: nonce.toLowerCase(), status: 'confirmed', txHash: '0x' + '12'.repeat(32) }
  ;(proxy as any)._sweepReceipts.set(nonce.toLowerCase(), receipt)

  assert.equal(proxy.getSweepReceipt(nonce), receipt)
  assert.equal(proxy.getSweepReceipt(nonce.toLowerCase()), receipt)
  assert.equal(proxy.getSweepReceipt('0x' + '00'.repeat(32)), null)
})
