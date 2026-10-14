import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node'
import { BuyerProxy, type BuyerBalanceReader, type BuyerProxyConfig } from './buyer-proxy.js'
import { BUYER_IDENTITY_HEADER } from './request-utils.js'
import {
  GATEWAY_CONTROL_HEADER,
  GATEWAY_CONTROL_SECRET_FILE,
  ROUTING_POLICY_HEADER,
  encodePolicyHeader,
  type RoutingPolicy,
} from '../routing-policy/policy.js'

const SECRET = 'f'.repeat(64)

function makePeer(seed: string, opts: { input: number; output: number; trust: number; capabilities?: string[] }): PeerInfo {
  return {
    peerId: seed.repeat(40) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: ['openai'],
    onChainReputationScore: opts.trust,
    displayName: `Test seller ${seed}`,
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    providerPricing: { openai: { defaults: { inputUsdPerMillion: opts.input, outputUsdPerMillion: opts.output } } },
    providerServiceApiProtocols: { openai: { services: { 'gpt-5': ['openai-chat-completions'] } } },
  }
}

interface Harness {
  proxy: BuyerProxy
  url: string
  dispatched: Array<{ peerId: string; headers: Record<string, string>; buyerIdentity?: string }>
}

async function startHarness(t: TestContext, peers: PeerInfo[], extra: Partial<BuyerProxyConfig> = {}, withSecret = true): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'antseed-gateway-policy-'))
  let proxy: BuyerProxy | undefined
  // Conversation writes land in the data dir: let them finish before removing it.
  t.after(async () => {
    await (proxy as any)?._conversations.flush()
    await rm(dataDir, { recursive: true, force: true })
  })
  if (withSecret) {
    await mkdir(join(dataDir, 'gateway'), { recursive: true })
    await writeFile(join(dataDir, GATEWAY_CONTROL_SECRET_FILE), `${SECRET}\n`, { mode: 0o600 })
  }
  const dispatched: Harness['dispatched'] = []
  const node = {
    router: { allowsPeerForPolicy: () => true, onResult: () => {} },
    buyerIdentities: () => [{ name: 'default', address: '0x' + '1'.repeat(40) }],
    sendRequest: async (peer: PeerInfo, request: SerializedHttpRequest, options?: { buyerIdentity?: string }) => {
      dispatched.push({ peerId: peer.peerId, headers: request.headers, buyerIdentity: options?.buyerIdentity })
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') }
    },
  }
  proxy = new BuyerProxy({ port: 0, dataDir, node: node as any, ...extra })
  ;(proxy as any)._getPeers = async () => peers
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  ;(proxy as any)._mergeStateFile = async () => {}
  const server = (proxy as any)._server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  return { proxy, url: `http://127.0.0.1:${port}`, dispatched }
}

function chat(h: Harness, headers: Record<string, string> = {}, model = 'gpt-5'): Promise<Response> {
  return fetch(`${h.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [] }),
  })
}

function withPolicy(policy: RoutingPolicy): Record<string, string> {
  return { [GATEWAY_CONTROL_HEADER]: SECRET, [ROUTING_POLICY_HEADER]: encodePolicyHeader(policy) }
}

const cheap = makePeer('a', { input: 1, output: 1, trust: 70 })
const pricey = makePeer('b', { input: 9, output: 9, trust: 95 })

test('an authenticated policy filters automatic routing and both headers are stripped', async (t) => {
  const h = await startHarness(t, [cheap, pricey])
  const res = await chat(h, withPolicy({ blockedPeerIds: [pricey.peerId] }))
  assert.equal(res.status, 200)
  assert.equal(h.dispatched[0]?.peerId, cheap.peerId)
  assert.equal(h.dispatched[0]?.headers[GATEWAY_CONTROL_HEADER], undefined)
  assert.equal(h.dispatched[0]?.headers[ROUTING_POLICY_HEADER], undefined)
})

test('/v1/models under a gateway policy lists only the models and sellers the policy allows', async (t) => {
  const h = await startHarness(t, [cheap, pricey])
  const list = async (headers: Record<string, string> = {}) => {
    const res = await fetch(`${h.url}/v1/models`, { headers })
    assert.equal(res.status, 200)
    const body = await res.json() as { data: Array<{ id: string; peers: Array<{ peerId: string }> }> }
    return body.data.map((model) => [model.id, model.peers.map((peer) => peer.peerId).sort()])
  }
  assert.deepEqual(await list(), [['gpt-5', [cheap.peerId, pricey.peerId]]])
  assert.deepEqual(await list(withPolicy({ blockedPeerIds: [pricey.peerId] })), [['gpt-5', [cheap.peerId]]])
  assert.deepEqual(await list(withPolicy({ maxInputUsdPerMillion: 5 })), [['gpt-5', [cheap.peerId]]])
  assert.deepEqual(await list(withPolicy({ allowedModels: ['other-model'] })), [])
  assert.deepEqual(await list(withPolicy({ modelRoutes: { 'gpt-5': { peerIds: [pricey.peerId], strict: true } } })), [['gpt-5', [pricey.peerId]]])
  const forged = await fetch(`${h.url}/v1/models`, { headers: { [GATEWAY_CONTROL_HEADER]: 'nope', [ROUTING_POLICY_HEADER]: encodePolicyHeader({ allowedModels: [] }) } })
  assert.equal(forged.status, 401)
})

test('sort modes change which seller is tried first', async (t) => {
  const h = await startHarness(t, [cheap, pricey])
  await chat(h, withPolicy({ sort: 'trust' }))
  await chat(h, withPolicy({ sort: 'price' }))
  assert.deepEqual(h.dispatched.map((entry) => entry.peerId), [pricey.peerId, cheap.peerId])
})

test('a policy sent without any control header is stripped and ignored', async (t) => {
  const h = await startHarness(t, [cheap, pricey])
  const res = await chat(h, { [ROUTING_POLICY_HEADER]: encodePolicyHeader({ allowedPeerIds: [] }) })
  assert.equal(res.status, 200)
  assert.equal(h.dispatched.length, 1)
  assert.equal(h.dispatched[0]?.headers[ROUTING_POLICY_HEADER], undefined)
  assert.equal(h.dispatched[0]?.headers[GATEWAY_CONTROL_HEADER], undefined)
})

test('a wrong control secret fails closed with 401 gateway_auth_invalid, with or without a policy', async (t) => {
  const h = await startHarness(t, [cheap, pricey])
  const withBadPolicy = await chat(h, {
    [GATEWAY_CONTROL_HEADER]: 'wrong',
    [ROUTING_POLICY_HEADER]: encodePolicyHeader({ allowedPeerIds: [] }),
  })
  assert.equal(withBadPolicy.status, 401)
  assert.equal(((await withBadPolicy.json()) as any).error.code, 'gateway_auth_invalid')
  const authOnly = await chat(h, { [GATEWAY_CONTROL_HEADER]: 'wrong' })
  assert.equal(authOnly.status, 401)
  assert.equal(h.dispatched.length, 0)
})

test('a mismatch re-reads a rotated secret immediately instead of waiting out the throttle', async (t) => {
  const h = await startHarness(t, [cheap, pricey])
  assert.equal((await chat(h, withPolicy({}))).status, 200)
  const rotated = 'e'.repeat(64)
  const dataDir = (h.proxy as any)._stateDir as string
  await writeFile(join(dataDir, GATEWAY_CONTROL_SECRET_FILE), `${rotated}\n`)
  // The cached secret was just read, so only the forced re-read can see the new one.
  ;(h.proxy as any)._controlSecretCheckedAt = Date.now()
  ;(h.proxy as any)._controlSecretForcedAt = 0
  const res = await chat(h, { [GATEWAY_CONTROL_HEADER]: rotated, [ROUTING_POLICY_HEADER]: encodePolicyHeader({}) })
  assert.equal(res.status, 200)
  // The old secret is now wrong; forced re-reads are rate limited, so this
  // one is rejected from the cache without touching the file.
  const stale = await chat(h, withPolicy({}))
  assert.equal(stale.status, 401)
})

test('the secret file is picked up when the gateway creates it after the buyer starts', async (t) => {
  const h = await startHarness(t, [cheap, pricey], {}, false)
  const before = await fetch(`${h.url}/_antseed/route-preview?model=gpt-5`, { headers: { [GATEWAY_CONTROL_HEADER]: SECRET } })
  assert.equal(before.status, 401)
  const dataDir = (h.proxy as any)._stateDir as string
  await mkdir(join(dataDir, 'gateway'), { recursive: true })
  await writeFile(join(dataDir, GATEWAY_CONTROL_SECRET_FILE), SECRET)
  ;(h.proxy as any)._controlSecretCheckedAt = 0
  const after = await fetch(`${h.url}/_antseed/route-preview?model=gpt-5`, { headers: { [GATEWAY_CONTROL_HEADER]: SECRET } })
  assert.equal(after.status, 200)
})

test('a malformed authenticated policy is rejected, never routed unrestricted', async (t) => {
  const h = await startHarness(t, [cheap, pricey])
  const res = await chat(h, { [GATEWAY_CONTROL_HEADER]: SECRET, [ROUTING_POLICY_HEADER]: 'bm90IGpzb24' })
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as any).error.code, 'invalid_routing_policy')
  assert.equal(h.dispatched.length, 0)
})

test('a disallowed model is refused with model_not_allowed', async (t) => {
  const h = await startHarness(t, [cheap, pricey])
  const res = await chat(h, withPolicy({ allowedModels: ['other-model'] }))
  assert.equal(res.status, 403)
  assert.equal(((await res.json()) as any).error.code, 'model_not_allowed')
})

test('hard pins the policy excludes get 403 peer_not_allowed; soft preferences are ignored', async (t) => {
  const h = await startHarness(t, [cheap, pricey])
  const policy = withPolicy({ blockedPeerIds: [pricey.peerId] })

  const headerPin = await chat(h, { ...policy, 'x-antseed-pin-peer': pricey.peerId })
  assert.equal(headerPin.status, 403)
  assert.equal(((await headerPin.json()) as any).error.code, 'peer_not_allowed')

  const modelPin = await chat(h, policy, `${pricey.peerId}@gpt-5`)
  assert.equal(modelPin.status, 403)

  const capped = await chat(h, { ...withPolicy({ maxInputUsdPerMillion: 2 }), 'x-antseed-pin-peer': pricey.peerId })
  assert.equal(capped.status, 403)
  assert.match(((await capped.json()) as any).error.message, /input price \$9 over cap \$2/)

  const strict = await chat(h, { ...withPolicy({ modelRoutes: { 'gpt-5': { peerIds: [cheap.peerId], strict: true } } }), 'x-antseed-pin-peer': pricey.peerId })
  assert.equal(strict.status, 403)

  const allowedPin = await chat(h, { ...policy, 'x-antseed-pin-peer': cheap.peerId })
  assert.equal(allowedPin.status, 200)

  const preferred = await chat(h, { ...policy, 'x-antseed-prefer-peer': pricey.peerId })
  assert.equal(preferred.status, 200)
  assert.deepEqual(h.dispatched.map((entry) => entry.peerId), [cheap.peerId, cheap.peerId])
})

test('the session pin cannot escape the policy either', async (t) => {
  const h = await startHarness(t, [cheap, pricey], { pinnedPeerId: pricey.peerId })
  const res = await chat(h, withPolicy({ allowedPeerIds: [cheap.peerId] }))
  assert.equal(res.status, 403)
  assert.equal(h.dispatched.length, 0)
})

test('strict and non-strict model routes on the automatic path', async (t) => {
  const third = makePeer('c', { input: 0.5, output: 0.5, trust: 99 })
  const h = await startHarness(t, [cheap, pricey, third])
  ;(h.proxy as any)._node.sendRequest = async (peer: PeerInfo, request: SerializedHttpRequest) => {
    h.dispatched.push({ peerId: peer.peerId, headers: request.headers })
    const status = peer.peerId === pricey.peerId ? 503 : 200
    return { requestId: request.requestId, statusCode: status, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') }
  }
  // Non-strict: chain first (pricey fails), then the chain's next seller.
  await chat(h, withPolicy({ modelRoutes: { 'gpt-5': { peerIds: [pricey.peerId, cheap.peerId] } } }))
  assert.deepEqual(h.dispatched.map((entry) => entry.peerId), [pricey.peerId, cheap.peerId])
  h.dispatched.length = 0
  // Strict: only the chain may serve; its failure is returned rather than falling through.
  const res = await chat(h, withPolicy({ modelRoutes: { 'gpt-5': { peerIds: [pricey.peerId], strict: true } } }))
  assert.equal(res.status, 503)
  assert.deepEqual(h.dispatched.map((entry) => entry.peerId), [pricey.peerId])
})

test('route-preview shares routing logic and explains ineligible sellers', async (t) => {
  const tee = makePeer('c', { input: 0.5, output: 0.5, trust: 40 })
  const h = await startHarness(t, [cheap, pricey, tee])
  ;(h.proxy as any)._peerHealth.set(cheap.peerId, { failureStreak: 3, cooldownUntil: Date.now() + 60_000, lastFailureAt: Date.now(), lastReason: 'seller-5xx', windowStartedAt: 0, episodeStartedAt: 0, lastSuccessAt: 0 })

  const unauth = await fetch(`${h.url}/_antseed/route-preview?model=gpt-5`)
  assert.equal(unauth.status, 401)

  const res = await fetch(`${h.url}/_antseed/route-preview?model=gpt-5`, {
    headers: withPolicy({ minTrustScore: 60, maxInputUsdPerMillion: 5, requireVerified: false }),
  })
  assert.equal(res.status, 200)
  const body = await res.json() as { model: string; candidates: Array<Record<string, unknown>> }
  assert.equal(body.model, 'gpt-5')
  const byId = new Map(body.candidates.map((candidate) => [candidate['peerId'], candidate]))
  assert.deepEqual(Object.keys(body.candidates[0]!).sort(), [
    'displayName', 'eligible', 'inputUsdPerMillion', 'outputUsdPerMillion', 'peerId', 'rank', 'reasons', 'trustScore',
  ])
  assert.equal(byId.get(pricey.peerId)?.['eligible'], false)
  assert.deepEqual(byId.get(pricey.peerId)?.['reasons'], ['input price $9 over cap $5'])
  assert.deepEqual(byId.get(tee.peerId)?.['reasons'], ['trust 40 below 60'])
  // The only ready seller is cooling down, so routing falls back to it.
  assert.equal(byId.get(cheap.peerId)?.['eligible'], true)
  assert.equal(byId.get(cheap.peerId)?.['rank'], 1)

  const verified = await fetch(`${h.url}/_antseed/route-preview?model=gpt-5`, { headers: withPolicy({ requireVerified: true }) })
  const verifiedBody = await verified.json() as { candidates: Array<{ eligible: boolean; reasons: string[] }> }
  assert.ok(verifiedBody.candidates.every((candidate) => !candidate.eligible && candidate.reasons.some((reason) => reason.startsWith('not verified'))))

  const bad = await fetch(`${h.url}/_antseed/route-preview?model=gpt-5`, { headers: { [GATEWAY_CONTROL_HEADER]: SECRET, [ROUTING_POLICY_HEADER]: '!!' } })
  assert.equal(bad.status, 400)
})

test('requireTee only admits sellers advertising the TEE verifier, on automatic, pinned and preview paths', async (t) => {
  const tee = makePeer('c', { input: 5, output: 5, trust: 50, capabilities: ['verifier.antseed-verifier'] })
  const h = await startHarness(t, [cheap, pricey, tee])
  const policy = withPolicy({ requireTee: true })

  assert.equal((await chat(h, policy)).status, 200)
  assert.deepEqual(h.dispatched.map((entry) => entry.peerId), [tee.peerId])

  const pinned = await chat(h, { ...policy, 'x-antseed-pin-peer': cheap.peerId })
  assert.equal(pinned.status, 403)
  assert.match(((await pinned.json()) as any).error.message, /no TEE/)

  const preview = await fetch(`${h.url}/_antseed/route-preview?model=gpt-5`, { headers: policy })
  const body = await preview.json() as { candidates: Array<{ peerId: string; eligible: boolean; reasons: string[] }> }
  const byId = new Map(body.candidates.map((candidate) => [candidate.peerId, candidate]))
  assert.equal(byId.get(tee.peerId)?.eligible, true)
  assert.deepEqual(byId.get(cheap.peerId)?.reasons, ['no TEE'])
})

test('restart is refused with restart_unsupported when the buyer is not supervised', async (t) => {
  const h = await startHarness(t, [cheap])
  const res = await fetch(`${h.url}/_antseed/restart`, { method: 'POST', headers: { [GATEWAY_CONTROL_HEADER]: SECRET } })
  assert.equal(res.status, 503)
  assert.equal(((await res.json()) as any).error, 'restart_unsupported')
})

test('a config reload keeps the startup min reputation, which the router plugin also enforces until restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-reload-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const configPath = join(dir, 'config.json')
  await writeFile(configPath, JSON.stringify({ buyer: { minPeerReputation: 10 } }))
  const previous = process.env['ANTSEED_BUYER_MIN_REPUTATION']
  process.env['ANTSEED_BUYER_MIN_REPUTATION'] = '65'
  t.after(() => {
    if (previous === undefined) delete process.env['ANTSEED_BUYER_MIN_REPUTATION']
    else process.env['ANTSEED_BUYER_MIN_REPUTATION'] = previous
  })
  const h = await startHarness(t, [cheap], { configPath, minPeerReputation: 65 })
  await (h.proxy as any)._reloadRoutingPreferences()
  assert.equal((h.proxy as any)._minPeerReputation, 65)
  delete process.env['ANTSEED_BUYER_MIN_REPUTATION']
  await (h.proxy as any)._reloadRoutingPreferences()
  assert.equal((h.proxy as any)._minPeerReputation, 65)
})

test('restart requires gateway auth, answers 202 and then runs the shutdown hook', async (t) => {
  let restarts = 0
  const h = await startHarness(t, [cheap], { onRestartRequested: () => { restarts += 1 }, minRestartIntervalMs: 0 })
  const denied = await fetch(`${h.url}/_antseed/restart`, { method: 'POST' })
  assert.equal(denied.status, 401)
  assert.equal(restarts, 0)
  const accepted = await fetch(`${h.url}/_antseed/restart`, { method: 'POST', headers: { [GATEWAY_CONTROL_HEADER]: SECRET } })
  assert.equal(accepted.status, 202)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(restarts, 1)
})

test('a restart is refused with 429 until the minimum interval since the buyer started has passed', async (t) => {
  let restarts = 0
  const h = await startHarness(t, [cheap], { onRestartRequested: () => { restarts += 1 } })
  const refused = await fetch(`${h.url}/_antseed/restart`, { method: 'POST', headers: { [GATEWAY_CONTROL_HEADER]: SECRET } })
  assert.equal(refused.status, 429)
  assert.equal(((await refused.json()) as any).error, 'restart_too_soon')
  assert.ok(Number(refused.headers.get('retry-after')) > 0)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(restarts, 0)
})

test('balances reads chain state per identity and caches it', async (t) => {
  let reads = 0
  const reader: BuyerBalanceReader = {
    getBuyerBalance: async () => { reads += 1; return { available: 1_500_000n, reserved: 250_000n } },
    getUSDCBalance: async () => 3_000_000n,
    getBuyerCreditLimit: async () => 10_000_000n,
    getOperator: async () => '0x0000000000000000000000000000000000000000',
  }
  const h = await startHarness(t, [cheap], { balanceReader: reader })
  const headers = { [GATEWAY_CONTROL_HEADER]: SECRET }
  assert.equal((await fetch(`${h.url}/_antseed/balances`)).status, 401)
  const res = await fetch(`${h.url}/_antseed/balances?identity=default`, { headers })
  assert.deepEqual(await res.json(), {
    address: '0x' + '1'.repeat(40),
    available: '1.500000',
    reserved: '0.250000',
    walletUsdc: '3.000000',
    creditLimit: '10.000000',
    operator: null,
  })
  await fetch(`${h.url}/_antseed/balances`, { headers })
  assert.equal(reads, 1)
})

test('peers endpoint exposes the extra picker fields', async (t) => {
  const peer = { ...cheap, maxConcurrency: 4, currentLoad: 1, onChainChannelCount: 7, onChainTotalVolumeUsdcMicros: 99, onChainLastSettledAtSec: 123, onChainSybilRisk: 0.1 }
  const h = await startHarness(t, [peer])
  const body = await (await fetch(`${h.url}/_antseed/peers`)).json() as { peers: Array<Record<string, unknown>> }
  assert.equal(body.peers[0]?.['maxConcurrency'], 4)
  assert.equal(body.peers[0]?.['currentLoad'], 1)
  assert.equal(body.peers[0]?.['onChainChannelCount'], 7)
  assert.equal(body.peers[0]?.['onChainTotalVolumeUsdcMicros'], 99)
  assert.equal(body.peers[0]?.['onChainLastSettledAtSec'], 123)
  assert.equal(body.peers[0]?.['onChainSybilRisk'], 0.1)
})

test('deposit watcher status and mode are addressable per identity', async (t) => {
  const h = await startHarness(t, [cheap])
  const modes: string[] = []
  const watcher = { status: () => ({ mode: 'idle' }), promote: () => modes.push('active'), demote: () => modes.push('background') }
  h.proxy.setDepositWatcher(watcher as any)
  ;(h.proxy as any)._buyerIdentities = { ensure: async (name: string) => name === 'team-a' }
  h.proxy.setIdentityDepositWatcher('team-a', { ...watcher, status: () => ({ mode: 'team' }) } as any)

  const status = await (await fetch(`${h.url}/_antseed/deposits/status?identity=team-a`)).json() as Record<string, unknown>
  assert.equal(status['watcher'], true)
  assert.deepEqual(status['status'], { mode: 'team' })
  const watch = await fetch(`${h.url}/_antseed/deposits/watch`, { method: 'POST', body: JSON.stringify({ mode: 'active', identity: 'team-a' }) })
  assert.equal(watch.status, 200)
  assert.deepEqual(modes, ['active'])

  h.proxy.setIdentityDepositWatcher('team-a', null)
  const missing = await (await fetch(`${h.url}/_antseed/deposits/status?identity=team-a`)).json() as Record<string, unknown>
  assert.equal(missing['watcher'], false)
  assert.equal(missing['reason'], 'identity-not-watched')
  assert.equal((await fetch(`${h.url}/_antseed/deposits/status?identity=nobody`)).status, 404)
})

test('paying as a non-default buyer identity requires the gateway control secret once one exists', async (t) => {
  const h = await startHarness(t, [cheap])
  ;(h.proxy as any)._buyerIdentities = { ensure: async (name: string) => name === 'team-a' }
  const identity = { [BUYER_IDENTITY_HEADER]: 'Team-A' }

  const refused = await chat(h, identity)
  assert.equal(refused.status, 401)
  assert.equal(((await refused.json()) as any).error.code, 'gateway_auth_required')
  assert.equal((await chat(h, { ...identity, [GATEWAY_CONTROL_HEADER]: 'wrong' })).status, 401)
  assert.equal(h.dispatched.length, 0)

  assert.equal((await chat(h, { ...identity, [GATEWAY_CONTROL_HEADER]: SECRET })).status, 200)
  assert.equal(h.dispatched[0]?.buyerIdentity, 'team-a')
  assert.equal(h.dispatched[0]?.headers[BUYER_IDENTITY_HEADER], undefined)

  // The default wallet needs no secret, named or not.
  assert.equal((await chat(h, { [BUYER_IDENTITY_HEADER]: 'default' })).status, 200)
  assert.equal((await chat(h)).status, 200)
  assert.equal(h.dispatched[2]?.buyerIdentity, undefined)

  const close = await fetch(`${h.url}/_antseed/channels/close`, { method: 'POST', body: JSON.stringify({ peerId: cheap.peerId, identity: 'team-a' }) })
  assert.equal(close.status, 401)
})

test('without a control secret a loopback caller may still pay as a non-default buyer identity', async (t) => {
  const h = await startHarness(t, [cheap], {}, false)
  ;(h.proxy as any)._buyerIdentities = { ensure: async (name: string) => name === 'team-a' }
  assert.equal((await chat(h, { [BUYER_IDENTITY_HEADER]: 'team-a' })).status, 200)
  assert.equal(h.dispatched[0]?.buyerIdentity, 'team-a')
})

test('verification snapshot accepts the gateway control secret', async (t) => {
  const h = await startHarness(t, [cheap])
  ;(h.proxy as any)._teeControl.ready = true
  assert.equal((await fetch(`${h.url}/_antseed/verification`)).status, 403)
  const res = await fetch(`${h.url}/_antseed/verification`, { headers: { [GATEWAY_CONTROL_HEADER]: SECRET } })
  assert.equal(res.status, 200)
})

// Requests without restrictions must route exactly as on a buyer without a
// gateway, down to the error message.
test('no policy, or one that changes nothing, routes like main; unknown models get the original error', async (t) => {
  const h = await startHarness(t, [cheap, pricey])
  const expected = { type: 'model_not_found', code: 'model_not_found', message: 'No policy-allowed peer currently serves model "qwen3-coder".', param: 'model' }
  for (const headers of [{}, { [GATEWAY_CONTROL_HEADER]: SECRET }, withPolicy({}), withPolicy({ sort: 'balanced', preferFreePeers: false, requireVerified: false, requireTee: false })]) {
    const res = await chat(h, headers, 'qwen3-coder')
    assert.equal(res.status, 502)
    assert.deepEqual(((await res.json()) as any).error, expected)
  }
  for (const headers of [{}, withPolicy({ sort: 'balanced', preferFreePeers: false })]) {
    assert.equal((await chat(h, headers)).status, 200)
  }
  // Both requests ranked the same way (balanced: higher trust first).
  assert.deepEqual(h.dispatched.map((entry) => entry.peerId), [pricey.peerId, pricey.peerId])
})

test('the buyer\'s own limits are judged once, by its router, not again by a gateway policy', async (t) => {
  // The router plugin (fake: allows everyone) is where buyer.minPeerReputation
  // is enforced; a gateway policy must not re-apply it with other inputs.
  const h = await startHarness(t, [cheap, pricey], { minPeerReputation: 80 })
  assert.equal((await chat(h, withPolicy({ sort: 'price' }))).status, 200)
  assert.equal(h.dispatched[0]?.peerId, cheap.peerId)
  // Explicit gateway restrictions still apply.
  assert.equal((await chat(h, withPolicy({ sort: 'price', minReputation: 80 }))).status, 200)
  assert.equal(h.dispatched[1]?.peerId, pricey.peerId)
})

// The buyer's routing preferences are the top level of the policy chain for
// automatic routing: a gateway policy narrows them and never loosens them.
// Pins are judged by the gateway policy and the hard limits only, as without
// a gateway.
const prefs60 = { preferFreePeers: false, maxInputUsdPerMillion: 25, minTrustScore: 60, allowedPeerIds: [], blockedPeerIds: [] }
const trust58 = makePeer('d', { input: 1, output: 1, trust: 58 })

test('a pin through a gateway default with an unrelated model route ignores the buyer trust preference', async (t) => {
  const h = await startHarness(t, [trust58, pricey], { routingPreferences: prefs60 })
  const policy = withPolicy({ modelRoutes: { 'other-model': { peerIds: [pricey.peerId] } } })
  const res = await chat(h, policy, `${trust58.peerId}@gpt-5`)
  assert.equal(res.status, 200)
  assert.equal(h.dispatched[0]?.peerId, trust58.peerId)
  // The same pin without a gateway behaves as before (pins never checked preferences).
  assert.equal((await chat(h, {}, `${trust58.peerId}@gpt-5`)).status, 200)
})

test('a gateway policy cannot loosen the buyer trust minimum or its block list', async (t) => {
  const h = await startHarness(t, [trust58, cheap, pricey], { routingPreferences: { ...prefs60, blockedPeerIds: [pricey.peerId] } })
  // A lower gateway minimum changes nothing: the buyer's 60 still holds, and so does its block list.
  assert.equal((await chat(h, withPolicy({ minTrustScore: 5, sort: 'price' }))).status, 200)
  assert.equal(h.dispatched[0]?.peerId, cheap.peerId)

  const preview = await fetch(`${h.url}/_antseed/route-preview?model=gpt-5`, { headers: withPolicy({ minTrustScore: 5 }) })
  const body = await preview.json() as { candidates: Array<{ peerId: string; eligible: boolean; reasons: string[] }>; buyer: RoutingPolicy }
  const byId = new Map(body.candidates.map((candidate) => [candidate.peerId, candidate]))
  assert.deepEqual(byId.get(trust58.peerId)?.reasons, ['buyer config: trust 58 below 60'])
  assert.deepEqual(byId.get(pricey.peerId)?.reasons, ['buyer config: blocked'])
  assert.equal(byId.get(cheap.peerId)?.eligible, true)
  assert.deepEqual(body.buyer, { blockedPeerIds: [pricey.peerId.toLowerCase()], minTrustScore: 60 })

  // A stricter gateway minimum narrows further, reported at the gateway level.
  const stricter = await fetch(`${h.url}/_antseed/route-preview?model=gpt-5`, { headers: withPolicy({ minTrustScore: 75 }) })
  const stricterBody = await stricter.json() as { candidates: Array<{ peerId: string; reasons: string[] }> }
  const cheapVerdict = stricterBody.candidates.find((candidate) => candidate.peerId === cheap.peerId)
  assert.deepEqual(cheapVerdict?.reasons, ['trust 70 below 75'])
})

test('hard buyer limits still apply to pins under a gateway policy and are named in the reason', async (t) => {
  const h = await startHarness(t, [cheap, pricey], { minPeerReputation: 80, routingPreferences: prefs60 })
  const res = await chat(h, { ...withPolicy({ minTrustScore: 5 }), 'x-antseed-pin-peer': cheap.peerId })
  assert.equal(res.status, 403)
  const error = ((await res.json()) as any).error
  assert.equal(error.code, 'peer_not_allowed')
  assert.match(error.message, /buyer config: reputation 70 below 80/)
  assert.equal((await chat(h, { ...withPolicy({ minTrustScore: 5 }), 'x-antseed-pin-peer': pricey.peerId })).status, 200)

  const preview = await fetch(`${h.url}/_antseed/route-preview?model=gpt-5`, { headers: withPolicy({}) })
  assert.deepEqual(((await preview.json()) as any).buyer, { minReputation: 80, minTrustScore: 60 })
})

test('router-enforced buyer limits are labelled in the preview', async (t) => {
  const h = await startHarness(t, [cheap, pricey])
  ;(h.proxy as any)._node.router = {
    allowsPeerForPolicy: (_req: SerializedHttpRequest, peer: PeerInfo) => peer.peerId !== cheap.peerId,
    explainPolicyRejection: () => 'reputation 30 below buyer minimum 40',
    onResult: () => {},
  }
  const preview = await fetch(`${h.url}/_antseed/route-preview?model=gpt-5`, { headers: withPolicy({ sort: 'price' }) })
  const body = await preview.json() as { candidates: Array<{ peerId: string; reasons: string[] }> }
  const byId = new Map(body.candidates.map((candidate) => [candidate.peerId, candidate]))
  assert.deepEqual(byId.get(cheap.peerId)?.reasons, ['buyer config: reputation 30 below 40'])
})

test('under a gateway policy the buyer trust minimum still excludes, and its free-first still ranks', async (t) => {
  const lowTrustFree = makePeer('e', { input: 0, output: 0, trust: 20 })
  const free = makePeer('f', { input: 0, output: 0, trust: 65 })
  const h = await startHarness(t, [cheap, lowTrustFree], { routingPreferences: { ...prefs60, preferFreePeers: true } })
  await chat(h, withPolicy({ minTrustScore: 5 }))
  assert.equal(h.dispatched[0]?.peerId, cheap.peerId)

  const h2 = await startHarness(t, [cheap, free, lowTrustFree], { routingPreferences: { ...prefs60, preferFreePeers: true } })
  await chat(h2, withPolicy({ sort: 'trust' }))
  assert.equal(h2.dispatched[0]?.peerId, free.peerId)
  // `preferFreePeers: false` means "not set" in a policy, so the buyer's
  // free-first stays on; a gateway can turn it on, not off.
  const h3 = await startHarness(t, [cheap, free, lowTrustFree], { routingPreferences: { ...prefs60, preferFreePeers: true } })
  await chat(h3, withPolicy({ sort: 'trust', preferFreePeers: false }))
  assert.equal(h3.dispatched[0]?.peerId, free.peerId)
})

test('the attributed-spend feed is readable only with the gateway control secret', async (t) => {
  const h = await startHarness(t, [cheap])
  assert.equal((await fetch(`${h.url}/_antseed/attributed-spend?after=0`)).status, 401)
  assert.equal((await fetch(`${h.url}/_antseed/attributed-spend?after=0`, { headers: { [GATEWAY_CONTROL_HEADER]: 'wrong' } })).status, 401)
  const res = await fetch(`${h.url}/_antseed/attributed-spend?after=0`, { headers: { [GATEWAY_CONTROL_HEADER]: SECRET } })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as any).ok, true)
})

test('without a control secret the attributed-spend feed stays readable and unacknowledged', async (t) => {
  const h = await startHarness(t, [cheap], {}, false)
  const res = await fetch(`${h.url}/_antseed/attributed-spend?after=0`, { headers: { [GATEWAY_CONTROL_HEADER]: 'from-another-data-dir' } })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as any).ok, true)
})

test('latency is measured per seller and model', async (t) => {
  const h = await startHarness(t, [cheap])
  ;(h.proxy as any)._recordPeerLatency(cheap.peerId, 'gpt-5', 100)
  ;(h.proxy as any)._recordPeerLatency(cheap.peerId, 'GPT-5', 200)
  ;(h.proxy as any)._recordPeerLatency(cheap.peerId, 'big-model', 5000)
  assert.equal((h.proxy as any)._peerLatency(cheap.peerId, 'gpt-5'), 130)
  assert.equal((h.proxy as any)._peerLatency(cheap.peerId, 'big-model'), 5000)
  assert.equal((h.proxy as any)._peerLatency(cheap.peerId, 'other'), null)
})

test('gateway-policy automatic routing falls back to a free seller when a paid one cannot be funded, and remembers only the seller that answered', async (t) => {
  const paid = makePeer('a', { input: 1, output: 1, trust: 95 })
  const free = makePeer('e', { input: 0, output: 0, trust: 70 })
  const other = makePeer('b', { input: 2, output: 2, trust: 90 })
  const h = await startHarness(t, [paid, other, free])
  ;(h.proxy as any)._node.sendRequest = async (peer: PeerInfo, request: SerializedHttpRequest) => {
    h.dispatched.push({ peerId: peer.peerId, headers: request.headers })
    if (peer.peerId === free.peerId) {
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') }
    }
    return {
      requestId: request.requestId, statusCode: 402,
      headers: { 'content-type': 'application/json', 'x-antseed-fault-attribution': 'buyer' },
      body: Buffer.from('{"error":"payment_required","code":"insufficient_deposits"}'),
    }
  }
  const gatewayPolicy = withPolicy({ sort: 'trust' })
  const res = await chat(h, { ...gatewayPolicy, 'x-antseed-chat-session-id': 'thread-1' })
  assert.equal(res.status, 200)
  // The paid seller refused; the other paid one is skipped; the free one answered.
  assert.deepEqual(h.dispatched.map((entry) => entry.peerId), [paid.peerId, free.peerId])
  const conversation = (h.proxy as any)._conversations.get('antseed-chat:thread-1')
  assert.match(conversation?.pinnedModel ?? '', new RegExp(`^${free.peerId}@`))

  // With no free seller left, the buyer's 402 reaches the client and no route is remembered.
  const h2 = await startHarness(t, [paid])
  ;(h2.proxy as any)._node.sendRequest = (h.proxy as any)._node.sendRequest
  const refused = await chat(h2, { ...gatewayPolicy, 'x-antseed-chat-session-id': 'thread-2' })
  assert.equal(refused.status, 402)
  assert.equal((h2.proxy as any)._conversations.get('antseed-chat:thread-2')?.pinnedModel ?? null, null)
})

test('without a gateway policy a 402 reaches the client from the first seller, as before', async (t) => {
  const paid = makePeer('a', { input: 1, output: 1, trust: 95 })
  const free = makePeer('e', { input: 0, output: 0, trust: 70 })
  const h = await startHarness(t, [paid, free])
  ;(h.proxy as any)._node.sendRequest = async (peer: PeerInfo, request: SerializedHttpRequest) => {
    h.dispatched.push({ peerId: peer.peerId, headers: request.headers })
    return {
      requestId: request.requestId, statusCode: 402,
      headers: { 'content-type': 'application/json', 'x-antseed-fault-attribution': 'buyer' },
      body: Buffer.from('{"error":"payment_required","code":"insufficient_deposits"}'),
    }
  }
  const res = await chat(h)
  assert.equal(res.status, 402)
  assert.equal(h.dispatched.length, 1)
})

test('model_not_found moves to the next seller with or without a gateway policy', async (t) => {
  const stale = makePeer('a', { input: 1, output: 1, trust: 95 })
  const serving = makePeer('b', { input: 2, output: 2, trust: 90 })
  const h = await startHarness(t, [stale, serving])
  ;(h.proxy as any)._refreshPeersNow = async () => {}
  ;(h.proxy as any)._node.sendRequest = async (peer: PeerInfo, request: SerializedHttpRequest) => {
    h.dispatched.push({ peerId: peer.peerId, headers: request.headers })
    const notServed = peer.peerId === stale.peerId
    return {
      requestId: request.requestId,
      statusCode: notServed ? 400 : 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(notServed
        ? { error: { message: 'Service "gpt-5" is not served by this peer.', type: 'invalid_request_error', code: 'model_not_found' } }
        : {})),
    }
  }
  const viaGateway = await chat(h, withPolicy({ sort: 'trust' }))
  assert.equal(viaGateway.status, 200)
  assert.deepEqual(h.dispatched.map((entry) => entry.peerId), [stale.peerId, serving.peerId])

  h.dispatched.length = 0
  const plain = await chat(h)
  assert.equal(plain.status, 200)
  assert.deepEqual(h.dispatched.map((entry) => entry.peerId), [stale.peerId, serving.peerId])
})

test('a seller that answers with an error does not become the chat\'s route', async (t) => {
  const h = await startHarness(t, [cheap])
  ;(h.proxy as any)._node.sendRequest = async (peer: PeerInfo, request: SerializedHttpRequest) => {
    h.dispatched.push({ peerId: peer.peerId, headers: request.headers })
    return {
      requestId: request.requestId, statusCode: 400,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"error":{"message":"bad request","type":"invalid_request_error"}}'),
    }
  }
  const res = await chat(h, { 'x-antseed-chat-session-id': 'thread-err' })
  assert.equal(res.status, 400)
  assert.equal((h.proxy as any)._conversations.get('antseed-chat:thread-err')?.pinnedModel ?? null, null)
})
