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
import { GATEWAY_INTERNAL_KEY_HEADER, GatewayServer } from './server.js'
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
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-antseed-request-id': requestId })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'good-model', aliases: [] }, { id: 'other', aliases: ['other-model'] }, { id: 'GOOD', aliases: ['good-model-v2'] }] }))
        return
      }
      const tag = req.headers[SPEND_ATTRIBUTION_HEADER] as string | undefined
      if (tag && options.costUsdc) {
        feed.track(requestId, tag)
        feed.record({
          requestId, buyerIdentity: (req.headers[BUYER_IDENTITY_HEADER] as string | undefined) ?? 'default', sellerPeerId: 'f00d',
          amountUsdc: String(options.costUsdc), inputTokens: '10', cachedInputTokens: '0', outputTokens: '5', outputImages: '0',
        })
      }
      if (Buffer.concat(chunks).toString('utf8').includes('"stream":true')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-antseed-request-id': requestId, 'x-antseed-peer-id': 'f00d', 'x-antseed-first-token-ms': '150' })
        res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
        setTimeout(() => res.end('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":40,"total_tokens":50}}\n\ndata: [DONE]\n\n'), 200)
        return
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

test('a streamed answer logs the buyer\'s time to first token and the output speed', async () => {
  const ctx = await setup()
  try {
    const { secret, key } = ctx.store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null })
    assert.equal((await ctx.send(secret, '/v1/chat/completions', { model: 'm', stream: true })).status, 200)
    await ctx.send(secret, '/v1/chat/completions', { model: 'm' })
    const [plain, streamed] = ctx.store.listRequests({ keyId: key.id })
    assert.equal(streamed!.firstTokenMs, 150)
    assert.ok(streamed!.tokensPerSecond! > 100 && streamed!.tokensPerSecond! <= 205, `40 tokens over ~200ms (${streamed!.tokensPerSecond})`)
    assert.equal(plain!.firstTokenMs, null, 'a non-streamed answer has no first token')
    assert.equal(plain!.tokensPerSecond, null)
    const [stat] = ctx.store.peerStats(0)
    assert.equal(stat!.firstTokenMsP50, 150)
    assert.equal(stat!.tokensPerSecondP50, streamed!.tokensPerSecond)
  } finally {
    await ctx.close()
  }
})

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

test('a routing service pinned as the model passes the allow list like any model, with its routing options', async () => {
  const ctx = await setup()
  try {
    const router = `${'d'.repeat(40)}@alpha-route`
    const open = ctx.store.createKey({ label: 'open', limits: NO_LIMITS, expiresAt: null })
    const body = { model: router, messages: [], routing: { cost_quality_tradeoff: 8 } }
    assert.equal((await ctx.send(open.secret, '/v1/chat/completions', body)).status, 200)
    assert.deepEqual(JSON.parse(ctx.buyer.captured.at(-1)!.body).routing, { cost_quality_tradeoff: 8 })
    const limited = ctx.store.createKey({ label: 'limited', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedModels: ['good-model'] } })
    const refused = await ctx.send(limited.secret, '/v1/chat/completions', body)
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'model_not_allowed')
    const allowed = ctx.store.createKey({ label: 'router', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedModels: ['alpha-route'] } })
    assert.equal((await ctx.send(allowed.secret, '/v1/chat/completions', body)).status, 200)
  } finally {
    await ctx.close()
  }
})

test('allowedModels and the request log use the model the buyer routes by (service before model)', async () => {
  const ctx = await setup()
  try {
    const { secret, key } = ctx.store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedModels: ['good-model'] } })
    const smuggled = await ctx.send(secret, '/v1/chat/completions', { model: 'good-model', service: 'other-model' })
    assert.equal(smuggled.status, 403, 'an allowed model cannot carry a disallowed service')
    assert.equal(smuggled.body.error.code, 'model_not_allowed')
    assert.equal((await ctx.send(secret, '/v1/chat/completions', { model: 'good-model', service: '' })).status, 403, 'a blank service routes nowhere the allow list knows')
    assert.equal((await ctx.send(secret, '/v1/chat/completions', { service: ' good-model ' })).status, 200)
    assert.equal((await ctx.send(secret, '/v1/chat/completions', { model: 'other-model', service: 'good-model' })).status, 200)
    assert.equal(ctx.buyer.captured.length, 2)
    assert.deepEqual(ctx.store.listRequests({ keyId: key.id }).map((row) => row.model), ['good-model', 'good-model'])

    // A preset's model is what is bought: a client `service` cannot route around it.
    const open = ctx.store.createKey({ label: 'open', limits: NO_LIMITS, expiresAt: null })
    ctx.store.createPreset({ slug: 'p', name: 'P', workspaceId: null, model: 'good-model', routingPolicy: null, systemPrompt: null, params: {} })
    assert.equal((await ctx.send(open.secret, '/v1/chat/completions', { model: 'x', service: '@preset/p' })).status, 200)
    const forwarded = JSON.parse(ctx.buyer.captured[2]!.body)
    assert.equal(forwarded.model, 'good-model')
    assert.equal(forwarded.service, undefined)
    assert.equal(ctx.store.listRequests({ keyId: open.key.id })[0]!.model, 'good-model')
  } finally {
    await ctx.close()
  }
})

test('/v1/models lists only the models the key may use, even when the buyer is not sent the policy', async () => {
  const ctx = await setup({ controlSecret: null })
  try {
    const listModels = async (secret: string) => {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/v1/models`, { headers: { authorization: `Bearer ${secret}` } })
      assert.equal(response.status, 200)
      return ((await response.json()) as { data: Array<{ id: string }> }).data.map((entry) => entry.id)
    }
    const limited = ctx.store.createKey({ label: 'limited', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedModels: ['good-model', 'good-model-v2'] } })
    assert.deepEqual(await listModels(limited.secret), ['good-model', 'GOOD'])
    const open = ctx.store.createKey({ label: 'open', limits: NO_LIMITS, expiresAt: null })
    assert.deepEqual(await listModels(open.secret), ['good-model', 'other', 'GOOD'])
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

test('a body too large to be sniffed still runs its preset and keeps its caps', async () => {
  const ctx = await setup()
  try {
    // Caps are only worth anything if the preset is applied: an unresolved
    // `@preset/` alias must never reach the buyer as a model name.
    const { secret, key } = ctx.store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedModels: ['fast-model'] } })
    ctx.store.createPreset({
      slug: 'cap', name: 'Cap', workspaceId: key.workspaceId, model: 'fast-model',
      routingPolicy: { maxInputUsdPerMillion: 5_000, maxOutputUsdPerMillion: 10_000 }, systemPrompt: null, params: {},
    })
    const large = { model: '@preset/cap', messages: [{ role: 'user', content: 'x'.repeat(5 * 1024 * 1024) }] }
    const response = await ctx.send(secret, '/v1/chat/completions', large)
    assert.equal(response.status, 200)
    const forwarded = ctx.buyer.captured[0]!
    assert.equal(JSON.parse(forwarded.body).model, 'fast-model')
    assert.ok(!forwarded.body.includes('@preset/'), 'the alias never reaches the buyer')
    const policy = decodePolicyHeader(forwarded.headers[ROUTING_POLICY_HEADER] as string)
    assert.ok(policy, 'the preset cap reaches the buyer')
    assert.equal(policy.maxInputUsdPerMillion, 5_000)
    assert.equal(policy.maxOutputUsdPerMillion, 10_000)
    assert.deepEqual(policy.allowedModels, ['fast-model'])
    assert.equal(ctx.store.listRequests({ keyId: key.id })[0]!.model, 'fast-model', 'the ledger records the model that is bought')

    const unknown = await ctx.send(secret, '/v1/chat/completions', { model: '@preset/nope', messages: [{ role: 'user', content: 'x'.repeat(5 * 1024 * 1024) }] })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.error.code, 'preset_not_found')
    assert.equal(ctx.buyer.captured.length, 1, 'nothing is forwarded for an unknown preset')
  } finally {
    await ctx.close()
  }
})

test('a large body never forwards an unresolved @preset/ alias to the buyer', async () => {
  const ctx = await setup()
  try {
    // The production symptom: with nothing else to stop it, an alias the
    // gateway failed to resolve went out as a model name and the buyer
    // answered `model_not_found` — the caps looked broken but were never read.
    const { secret } = ctx.store.createKey({ label: 'open', limits: NO_LIMITS, expiresAt: null })
    ctx.store.createPreset({ slug: 'cap', name: 'Cap', workspaceId: null, model: 'fast-model', routingPolicy: null, systemPrompt: null, params: {} })
    const large = { model: '@preset/cap', messages: [{ role: 'user', content: 'x'.repeat(5 * 1024 * 1024) }] }
    assert.equal((await ctx.send(secret, '/v1/chat/completions', large)).status, 200)
    const forwarded = ctx.buyer.captured[0]!
    assert.equal(JSON.parse(forwarded.body).model, 'fast-model')
    assert.ok(!forwarded.body.includes('@preset/'), 'the alias never reaches the buyer as a model')

    const unroutable = await ctx.send(secret, '/v1/chat/completions', { model: '@preset/nope', messages: [{ role: 'user', content: 'x'.repeat(5 * 1024 * 1024) }] })
    assert.equal(unroutable.status, 400, 'an unresolvable alias is refused, never forwarded')
    assert.equal(ctx.buyer.captured.length, 1)
  } finally {
    await ctx.close()
  }
})

test('a body too large to be sniffed is still allow-listed and accounted by its model', async () => {
  const ctx = await setup()
  try {
    const { secret, key } = ctx.store.createKey({ label: 'k', limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedModels: ['good-model'] } })
    const withContent = (body: Record<string, unknown>) => ({ ...body, messages: [{ role: 'user', content: 'x'.repeat(5 * 1024 * 1024) }] })
    assert.equal((await ctx.send(secret, '/v1/chat/completions', withContent({ model: 'good-model' }))).status, 200)
    assert.equal((await ctx.send(secret, '/v1/chat/completions', withContent({ model: 'other-model' }))).status, 403, 'a large body cannot smuggle a disallowed model past the allow list')
    assert.equal((await ctx.send(secret, '/v1/chat/completions', withContent({ model: 'good-model', service: 'other-model' }))).status, 403, 'nor past it through a service')
    assert.equal(ctx.store.listRequests({ keyId: key.id }).map((row) => row.model).filter(Boolean).join(','), 'good-model')
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

test('a non-default buyer identity always goes to the buyer with the control secret', async () => {
  const ctx = await setup()
  try {
    const team = ctx.store.createKey({ label: 'team', buyerIdentity: 'team-a', limits: NO_LIMITS, expiresAt: null })
    assert.equal((await ctx.send(team.secret, '/v1/chat/completions', { model: 'm' })).status, 200)
    const headers = ctx.buyer.captured[0]!.headers
    assert.equal(headers[BUYER_IDENTITY_HEADER], 'team-a')
    assert.equal(headers[GATEWAY_CONTROL_HEADER], 'control-secret')
    assert.equal(headers[ROUTING_POLICY_HEADER], undefined)
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

test('the gateway itself can call /v1 as a key by id with the control secret; nobody else can, and the header never reaches the buyer', async () => {
  const ctx = await setup()
  try {
    const { key } = ctx.store.createKey({ label: 'chat', limits: NO_LIMITS, expiresAt: null })
    const body = { model: 'm', messages: [] }
    const asKey = { [GATEWAY_INTERNAL_KEY_HEADER]: key.id }
    // A key id alone, or with a wrong secret, is not a key.
    assert.equal((await ctx.send('', '/v1/chat/completions', body, asKey)).status, 401)
    assert.equal((await ctx.send('', '/v1/chat/completions', body, { ...asKey, [GATEWAY_CONTROL_HEADER]: 'nope' })).status, 401)
    const ok = await ctx.send('', '/v1/chat/completions', body, { ...asKey, [GATEWAY_CONTROL_HEADER]: 'control-secret' })
    assert.equal(ok.status, 200)
    const forwarded = ctx.buyer.captured.at(-1)!
    assert.equal(forwarded.headers[GATEWAY_INTERNAL_KEY_HEADER], undefined)
    // Accounted to that key like any request with it.
    assert.equal(ctx.store.getKey(key.id)!.lastUsedAt !== null, true)
    // From anyone else the header is ignored: a valid Bearer key still works and is the key used.
    const { secret: clientSecret, key: clientKey } = ctx.store.createKey({ label: 'client', limits: NO_LIMITS, expiresAt: null })
    assert.equal((await ctx.send(clientSecret, '/v1/chat/completions', body, asKey)).status, 200)
    assert.equal((await ctx.send(clientSecret, '/v1/chat/completions', body, { ...asKey, [GATEWAY_CONTROL_HEADER]: 'nope' })).status, 200)
    assert.equal(ctx.store.listRequests({ keyId: clientKey.id }).length, 2)
    assert.equal(ctx.buyer.captured.at(-1)!.headers[GATEWAY_INTERNAL_KEY_HEADER], undefined)
    // A revoked key stops working this way too.
    ctx.store.revokeKey(key.id)
    assert.equal((await ctx.send('', '/v1/chat/completions', body, { ...asKey, [GATEWAY_CONTROL_HEADER]: 'control-secret' })).status, 401)
  } finally {
    await ctx.close()
  }
})
