import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SpendAttributionFeed, SPEND_ATTRIBUTION_HEADER } from '../proxy/spend-attribution.js'
import { BUYER_IDENTITY_HEADER } from '../proxy/request-utils.js'
import { GATEWAY_CONTROL_HEADER, ROUTING_POLICY_HEADER, decodePolicyHeader } from '../routing-policy/policy.js'
import { GatewayAccounting } from './accounting.js'
import { OBSERVABILITY_SETTING } from './observability.js'
import { GATEWAY_ROUTING_SETTING } from './policy-resolver.js'
import { GatewayServer } from './server.js'
import { SpendFeedPoller } from './spend-feed.js'
import { GatewayStore } from './store.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }

type Captured = { url: string; headers: http.IncomingHttpHeaders; body: string }

async function fakeBuyer(options: { costUsdc?: number } = {}) {
  const feed = new SpendAttributionFeed()
  const captured: Captured[] = []
  let counter = 0
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/_antseed/attributed-spend')) {
      const after = Number(new URL(req.url, 'http://x').searchParams.get('after') ?? '0')
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ...feed.page(after) }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      captured.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      const requestId = `req-${++counter}`
      const tag = req.headers[SPEND_ATTRIBUTION_HEADER] as string | undefined
      if (tag && options.costUsdc) {
        feed.track(requestId, tag)
        feed.record({
          requestId, buyerIdentity: (req.headers[BUYER_IDENTITY_HEADER] as string | undefined) ?? 'default', sellerPeerId: 'f00d',
          amountUsdc: String(options.costUsdc), inputTokens: '10', cachedInputTokens: '0', outputTokens: '5', outputImages: '0',
        })
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-antseed-request-id': requestId, 'x-antseed-peer-id': 'f00d', 'x-antseed-latency-ms': '321' })
      res.end('{"answer":"ok"}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => { feed.close(); resolve() })),
  }
}

async function setup(options: { costUsdc?: number; controlSecret?: string | null; console?: { handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-gw-policy-'))
  const store = new GatewayStore(dir)
  const buyer = await fakeBuyer({ costUsdc: options.costUsdc })
  const accounting = new GatewayAccounting(store, { holdUsdc: 100_000, settleGraceMs: 20 })
  const feed = new SpendFeedPoller({ buyerPort: buyer.port, onPage: (page) => { accounting.ingest(page.bootId, page.events) }, intervalMs: 60_000 })
  const server = new GatewayServer({
    store,
    accounting,
    buyerPort: buyer.port,
    identityAddress: async () => null,
    spendFeedState: () => feed.state,
    refreshSpendFeed: () => feed.pollOnce(),
    controlSecret: options.controlSecret === undefined ? 'control-secret' : options.controlSecret,
    console: options.console ?? null,
  })
  const port = await server.start()
  const send = (secret: string, path: string, body: unknown, headers: http.OutgoingHttpHeaders = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body)
      const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...headers } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown = text
          try { parsed = JSON.parse(text) } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      })
      req.on('error', reject)
      req.end(payload)
    })
  return {
    store, buyer, feed, port, send, accounting, server,
    close: async () => {
      await server.stop()
      accounting.dispose()
      await buyer.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('the effective policy goes to the buyer with the control secret; client copies are dropped', async () => {
  const ctx = await setup()
  try {
    ctx.store.setSetting(GATEWAY_ROUTING_SETTING, { blockedPeerIds: ['dead'] })
    const { secret, key } = ctx.store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null, routingPolicy: { minTrustScore: 40 } })
    const forged = Buffer.from(JSON.stringify({})).toString('base64url')
    const response = await ctx.send(secret, '/v1/chat/completions', { model: 'm', user: 'end-user-7' }, {
      [ROUTING_POLICY_HEADER]: forged, [GATEWAY_CONTROL_HEADER]: 'guess', 'x-antseed-end-user': 'header-user',
    })
    assert.equal(response.status, 200)
    const headers = ctx.buyer.captured[0]!.headers
    assert.equal(headers[GATEWAY_CONTROL_HEADER], 'control-secret')
    assert.deepEqual(decodePolicyHeader(headers[ROUTING_POLICY_HEADER] as string), { blockedPeerIds: ['dead'], minTrustScore: 40 })
    assert.equal(headers['x-antseed-end-user'], undefined)

    const [row] = ctx.store.listRequests({ keyId: key.id })
    assert.equal(row!.sellerPeerId, 'f00d')
    assert.equal(row!.latencyMs, 321)
    assert.equal(row!.endUser, 'end-user-7')
    assert.equal(ctx.store.getRequest(row!.tag)!.requestBody, null, 'content is not logged by default')

    // Without any policy, nothing extra is sent and client copies are still dropped.
    ctx.store.setSetting(GATEWAY_ROUTING_SETTING, null)
    const plain = ctx.store.createKey({ label: 'plain', limits: NO_LIMITS, expiresAt: null })
    await ctx.send(plain.secret, '/v1/chat/completions', { model: 'm' }, { [ROUTING_POLICY_HEADER]: forged, [GATEWAY_CONTROL_HEADER]: 'guess' })
    assert.equal(ctx.buyer.captured[1]!.headers[ROUTING_POLICY_HEADER], undefined)
    assert.equal(ctx.buyer.captured[1]!.headers[GATEWAY_CONTROL_HEADER], undefined)
  } finally {
    await ctx.close()
  }
})

test('a seller-restricting policy without a control secret is refused, not routed unrestricted', async () => {
  const ctx = await setup({ controlSecret: null })
  try {
    const { secret } = ctx.store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedPeerIds: ['ab'] } })
    const response = await ctx.send(secret, '/v1/responses', { model: 'm' })
    assert.equal(response.status, 503)
    assert.equal(response.body.error.code, 'routing_policy_unavailable')
    assert.equal(ctx.buyer.captured.length, 0)
  } finally {
    await ctx.close()
  }
})

test('allowedModels is enforced by the gateway, including pinned peer@model', async () => {
  const ctx = await setup()
  try {
    const { secret } = ctx.store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedModels: ['good-model'] } })
    assert.equal((await ctx.send(secret, '/v1/chat/completions', { model: 'good-model' })).status, 200)
    assert.equal((await ctx.send(secret, '/v1/chat/completions', { model: 'beef@good-model' })).status, 200)
    const pinned = await ctx.send(secret, '/v1/chat/completions', { model: 'beef@other-model' })
    assert.equal(pinned.status, 403)
    assert.equal(pinned.body.error.code, 'model_not_allowed')
    assert.equal((await ctx.send(secret, '/v1/messages', { model: 'other-model' })).status, 403)
    assert.equal((await ctx.send(secret, '/v1/responses', {})).status, 403, 'no model under an allow list')
    assert.equal(ctx.buyer.captured.length, 2)
  } finally {
    await ctx.close()
  }
})

test('@preset/<slug> rewrites the request and narrows the policy', async () => {
  const ctx = await setup()
  try {
    const { secret, key } = ctx.store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
    ctx.store.createPreset({
      slug: 'fast', name: 'Fast', workspaceId: key.workspaceId, model: 'fast-model',
      routingPolicy: { sort: 'latency', allowedModels: ['fast-model'] }, systemPrompt: 'Answer in one line.', params: { temperature: 0, max_tokens: 50 },
    })
    const response = await ctx.send(secret, '/v1/chat/completions', { model: '@preset/fast', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(response.status, 200)
    const forwarded = JSON.parse(ctx.buyer.captured[0]!.body)
    assert.equal(forwarded.model, 'fast-model')
    assert.equal(forwarded.temperature, 0)
    assert.equal(forwarded.max_tokens, 10)
    assert.equal(forwarded.messages[0].content, 'Answer in one line.')
    assert.equal(ctx.buyer.captured[0]!.headers['content-length'], String(Buffer.byteLength(ctx.buyer.captured[0]!.body)))
    assert.deepEqual(decodePolicyHeader(ctx.buyer.captured[0]!.headers[ROUTING_POLICY_HEADER] as string), { sort: 'latency', allowedModels: ['fast-model'] })
    assert.equal(ctx.store.listRequests({})[0]!.model, 'fast-model')

    const missing = await ctx.send(secret, '/v1/chat/completions', { model: '@preset/nope' })
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error.code, 'preset_not_found')
  } finally {
    await ctx.close()
  }
})

test('a request is admitted only while key, member and workspace budgets all have room', async () => {
  const ctx = await setup({ costUsdc: 400_000 })
  try {
    const owner = ctx.store.createOwner({ label: 'O', email: null })
    const ws = ctx.store.createWorkspace({ name: 'W', buyerIdentity: 'ws-w', limits: { ...NO_LIMITS, weekly: 1_000_000 } })
    const a = ctx.store.createKey({ label: 'a', workspaceId: ws.id, limits: NO_LIMITS, expiresAt: null })
    const b = ctx.store.createKey({ label: 'b', workspaceId: ws.id, limits: NO_LIMITS, expiresAt: null })
    const send = (secret: string) => ctx.send(secret, '/v1/responses', { model: 'm' })
    assert.equal((await send(a.secret)).status, 200)
    await ctx.feed.pollOnce()
    assert.equal((await send(b.secret)).status, 200)
    await ctx.feed.pollOnce()
    assert.equal((await send(a.secret)).status, 200)
    await ctx.feed.pollOnce()
    const blocked = await send(b.secret)
    assert.equal(blocked.status, 402)
    assert.equal(blocked.body.error.code, 'spend_limit_reached')
    assert.equal(blocked.body.error.limit.level, 'workspace')
    assert.equal(blocked.body.error.limit.period, 'weekly')

    // Member budget across all of a member's keys.
    ctx.store.updateMember(owner.id, { limits: { daily: 300_000 } })
    const mine = ctx.store.createKey({ label: 'mine', limits: NO_LIMITS, expiresAt: null, ownerMemberId: owner.id })
    assert.equal((await send(mine.secret)).status, 200)
    await ctx.feed.pollOnce()
    const memberBlocked = await send(mine.secret)
    assert.equal(memberBlocked.status, 402)
    assert.equal(memberBlocked.body.error.limit.level, 'member')
    // Revoking the key and creating a new one escapes nothing.
    ctx.store.revokeKey(mine.key.id)
    const again = ctx.store.createKey({ label: 'again', limits: NO_LIMITS, expiresAt: null, ownerMemberId: owner.id })
    assert.equal((await send(again.secret)).body.error.limit.level, 'member')

    // The key's cap is the lower of the admin and the owner layer.
    const layered = ctx.store.createKey({ label: 'layered', limits: { ...NO_LIMITS, daily: 5_000_000 }, ownerLimits: { ...NO_LIMITS, daily: 300_000 }, expiresAt: null })
    assert.equal((await send(layered.secret)).status, 200)
    await ctx.feed.pollOnce()
    const ownerBlocked = await send(layered.secret)
    assert.equal(ownerBlocked.body.error.limit.level, 'key')
    assert.equal(ownerBlocked.body.error.limit.limit_usd, '0.300000')

    // Key-level weekly caps still work on their own.
    const weekly = ctx.store.createKey({ label: 'weekly', limits: { ...NO_LIMITS, weekly: 300_000 }, expiresAt: null })
    assert.equal((await send(weekly.secret)).status, 200)
    await ctx.feed.pollOnce()
    const keyBlocked = await send(weekly.secret)
    assert.equal(keyBlocked.body.error.limit.level, 'key')
    assert.equal(keyBlocked.body.error.limit.period, 'weekly')
  } finally {
    await ctx.close()
  }
})

test('content is logged only when enabled, and keys of disabled members stop working', async () => {
  const ctx = await setup()
  try {
    ctx.store.setSetting(OBSERVABILITY_SETTING, { otlpEndpoint: null, otlpHeaders: {}, logContent: true, retentionDays: null })
    const member = ctx.store.createOwner({ label: 'O', email: null })
    const { secret, key } = ctx.store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null, ownerMemberId: member.id })
    assert.equal((await ctx.send(secret, '/v1/responses', { model: 'm', input: 'hello' })).status, 200)
    const [listed] = ctx.store.listRequests({ keyId: key.id })
    const row = ctx.store.getRequest(listed!.tag)
    assert.equal(row!.requestBody, '{"model":"m","input":"hello"}')
    assert.equal(row!.responseBody, '{"answer":"ok"}')

    ctx.store.setMemberStatus(member.id, 'disabled')
    assert.equal((await ctx.send(secret, '/v1/responses', { model: 'm' })).status, 401)
  } finally {
    await ctx.close()
  }
})

test('requests under /console go to the console handler before API-key auth', async () => {
  const seen: string[] = []
  const ctx = await setup({
    console: {
      async handle(req, res) {
        seen.push(req.url ?? '')
        res.writeHead(200, { 'content-type': 'text/plain' }).end('console')
        return true
      },
    },
  })
  try {
    const response = await ctx.send('no-key', '/console/api/auth/config', {})
    assert.equal(response.status, 200)
    assert.equal(response.body, 'console')
    assert.equal((await ctx.send('no-key', '/consoles', {})).status, 404)
    assert.deepEqual(seen, ['/console/api/auth/config'])
  } finally {
    await ctx.close()
  }
})

test('a policy that changes nothing is not sent, so the request routes as with no policy at all', async () => {
  const ctx = await setup()
  try {
    ctx.store.setSetting(GATEWAY_ROUTING_SETTING, { sort: 'balanced', preferFreePeers: false, requireVerified: false })
    const { secret } = ctx.store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null, routingPolicy: { requireTee: false } })
    assert.equal((await ctx.send(secret, '/v1/chat/completions', { model: 'qwen3-coder' })).status, 200)
    assert.equal(ctx.buyer.captured[0]!.headers[ROUTING_POLICY_HEADER], undefined)
    assert.equal(ctx.buyer.captured[0]!.headers[GATEWAY_CONTROL_HEADER], undefined)

    // Only the settings that matter go out.
    ctx.store.setSetting(GATEWAY_ROUTING_SETTING, { sort: 'balanced', preferFreePeers: false, minTrustScore: 5 })
    await ctx.send(secret, '/v1/chat/completions', { model: 'qwen3-coder' })
    assert.deepEqual(decodePolicyHeader(ctx.buyer.captured[1]!.headers[ROUTING_POLICY_HEADER] as string), { minTrustScore: 5 })
  } finally {
    await ctx.close()
  }
})

test('a failure after admission answers 500 and releases the hold', async () => {
  const ctx = await setup({ costUsdc: 1 })
  try {
    const { secret, key } = ctx.store.createKey({ label: 'k', limits: { ...NO_LIMITS, daily: 1_000_000 }, expiresAt: null })
    await ctx.feed.pollOnce()
    const getSetting = ctx.store.getSetting.bind(ctx.store)
    ctx.store.getSetting = (<T>(name: string): T | null => {
      if (name === OBSERVABILITY_SETTING) throw new Error('settings unavailable')
      return getSetting<T>(name)
    }) as typeof ctx.store.getSetting
    const response = await ctx.send(secret, '/v1/responses', { model: 'm' })
    assert.equal(response.status, 500)
    assert.equal(response.body.error.code, 'internal_error')
    assert.equal(ctx.accounting.heldUsdc(key.id), 0, 'the hold is released')
    const [row] = ctx.store.listRequests({ keyId: key.id })
    assert.equal(row!.status, 500)
    assert.equal(ctx.buyer.captured.length, 0)
    ctx.store.getSetting = getSetting
  } finally {
    await ctx.close()
  }
})
