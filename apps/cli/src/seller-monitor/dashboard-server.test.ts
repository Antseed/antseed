import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { startSellerDashboard } from './dashboard-server.js'
import { linkToken, writeSellerFixture } from './fixture.js'

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghij'
const HOOK = 'https://hooks.example.test/services/T000/B000/secret-path'

function sellerConfig() {
  return {
    identity: { displayName: 'Test Seller' },
    seller: {
      maxConcurrentBuyers: 50,
      providers: { openai: { plugin: 'openai', baseUrl: 'https://upstream.example', services: { 'glm-5.3': { pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 3 } } } } },
      someFutureField: { kept: true },
    },
  }
}

async function harness(extra: Partial<Parameters<typeof startSellerDashboard>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seller-dashboard-'))
  writeSellerFixture(dir, { state: { updatedAt: Date.now(), peerId: '0xabc', modelHealth: [] } })
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify(sellerConfig(), null, 2))
  const outbound: Array<{ url: string; body: string | null }> = []
  const stub = (async (url: string, init?: RequestInit) => {
    outbound.push({ url: String(url), body: init?.body ? String(init.body) : null })
    if (String(url).includes('/getUpdates')) {
      return Response.json({ ok: true, result: [{ message: { chat: { id: -1001, title: 'Ops', type: 'supergroup' } } }, { message: { chat: { id: 42, first_name: 'Dana', type: 'private' } } }] })
    }
    return Response.json({ ok: true })
  }) as typeof fetch
  const server = await startSellerDashboard({ dataDir: dir, configPath, version: '9.9.9', port: 0, env: {}, fetch: stub, ...extra })
  const link = new URL(server.url)
  assert.equal(link.search, '', 'the token stays out of the query string')
  const opened = await fetch(`${link.origin}/console/api/auth/seller`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-antseed-console': '1' }, body: JSON.stringify({ token: linkToken(server.url) }) })
  assert.equal(opened.status, 204)
  const cookie = opened.headers.get('set-cookie')!.split(';')[0]!
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie, 'x-antseed-console': '1' }) => {
    const response = await fetch(`${link.origin}/console/api${path}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
    const text = await response.text()
    return { status: response.status, text, json: text ? JSON.parse(text) as Record<string, any> : null }
  }
  return { dir, configPath, server, link, cookie, call, outbound }
}

test('the seller dashboard needs its link, then serves the seller routes', async () => {
  const { server, link, cookie, call } = await harness()
  try {
    const token = linkToken(server.url)
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`${link.origin}${path}`, { headers, redirect: 'manual' })
    const noSession = await get('/console/api/auth/me')
    assert.equal(noSession.status, 401)
    assert.equal(((await noSession.json()) as { error: { code: string } }).error.code, 'seller_link_required')
    assert.equal((await get('/console/api/seller/status')).status, 401)
    const exchange = (offered: string) => fetch(`${link.origin}/console/api/auth/seller`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-antseed-console': '1' }, body: JSON.stringify({ token: offered }) })
    assert.equal((await exchange('wrong')).status, 401)
    assert.equal((await get(`/console/api/auth/seller?token=${token}`)).status, 404, 'a token in the query string opens nothing')
    assert.match(cookie, /^antseed_seller_dashboard_[0-9a-f]{12}=/)

    const me = (await call('GET', '/auth/me')).json!
    assert.deepEqual([me.kind, me.me.version], ['seller', '9.9.9'])
    const status = (await call('GET', '/seller/status')).json!
    assert.deepEqual([status.available, status.running, status.peerId], [true, true, '0xabc'])
    assert.equal((await get('/console/api/seller/usage?days=3', { authorization: `Bearer ${token}` })).status, 200)
    // Nothing gateway-shaped is mounted.
    assert.equal((await call('GET', '/workspaces')).status, 404)
    assert.equal((await get('/')).headers.get('location'), '/console/seller')
    // Writes need the console's CSRF header, as everywhere in the console.
    assert.equal((await call('PATCH', '/seller/settings', { maxConcurrentBuyers: 10 }, { cookie })).status, 403)
  } finally {
    await server.close()
  }
})

test('a malformed request target gets a 400 and the dashboard keeps serving', async () => {
  const { server, link, call } = await harness()
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(link.port), link.hostname, () => socket.write('GET //[/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))
      let data = ''
      socket.on('data', (chunk) => { data += chunk })
      socket.on('end', () => resolve(data))
      socket.on('error', reject)
    })
    assert.match(raw, /^HTTP\/1\.1 400/)
    assert.equal((await call('GET', '/seller/status')).status, 200)
  } finally {
    await server.close()
  }
})

test('alert secrets go to the secrets file, never to config.json or a response', async () => {
  const { dir, configPath, server, call, outbound } = await harness()
  try {
    const saved = await call('PATCH', '/seller/alerts', { telegramBotToken: TOKEN, telegramChatId: '-1001', webhookUrl: HOOK, idleMinutes: 30, minSeverity: 'warning' })
    assert.equal(saved.status, 200, saved.text)
    assert.ok(!saved.text.includes(TOKEN) && !saved.text.includes('secret-path'))
    assert.deepEqual(saved.json!.alerts.telegram, { chatId: '-1001', botTokenEnv: 'ANTSEED_ALERTS_TELEGRAM_TOKEN', tokenSet: true, tokenSource: 'file', active: true })
    assert.deepEqual(saved.json!.alerts.webhook, { set: true, host: 'hooks.example.test', source: 'file' })

    // Alert settings live in the data dir; config.json is not touched (it may be read-only).
    assert.equal(readFileSync(configPath, 'utf-8'), JSON.stringify(sellerConfig(), null, 2))
    const overrides = readFileSync(join(dir, 'seller-alerts.json'), 'utf-8')
    assert.ok(!overrides.includes(TOKEN) && !overrides.includes('secret-path'))
    assert.deepEqual(JSON.parse(overrides), { webhookFromConfig: false, telegramChatId: '-1001', idleMinutes: 30, minSeverity: 'warning' })
    const secretsFile = join(dir, 'secrets', 'seller-alerts.json')
    assert.equal(statSync(secretsFile).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, 'secrets')).mode & 0o777, 0o700)
    assert.deepEqual(JSON.parse(readFileSync(secretsFile, 'utf-8')), { telegramBotToken: TOKEN, webhookUrl: HOOK })

    const read = await call('GET', '/seller/settings')
    assert.ok(!read.text.includes(TOKEN) && !read.text.includes('secret-path'))

    const test1 = await call('POST', '/seller/alerts/test', { channel: 'telegram' })
    assert.deepEqual(test1.json, { sent: ['telegram'], errors: [] })
    assert.equal(outbound.at(-1)!.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`)
    assert.equal(JSON.parse(outbound.at(-1)!.body!).chat_id, '-1001')
    assert.deepEqual((await call('POST', '/seller/alerts/test', { channel: 'webhook' })).json, { sent: ['webhook'], errors: [] })
    assert.equal(outbound.at(-1)!.url, HOOK)

    const chats = await call('POST', '/seller/alerts/telegram/chats', {})
    assert.deepEqual(chats.json!.chats, [{ id: '42', title: 'Dana', type: 'private' }, { id: '-1001', title: 'Ops', type: 'supergroup' }])
    assert.ok(!chats.text.includes(TOKEN))
    // The latest updates, not the oldest page: a backlog never hides a new chat.
    assert.match(outbound.at(-1)!.url, /\/getUpdates\?offset=-100&limit=100$/)

    assert.equal((await call('PATCH', '/seller/alerts', { telegramBotToken: 'not-a-token' })).status, 400)
    assert.equal((await call('PATCH', '/seller/alerts', { webhookUrl: 'http://example.com/x' })).status, 400)
    const cleared = await call('PATCH', '/seller/alerts', { telegramBotToken: null, webhookUrl: null })
    assert.deepEqual([cleared.json!.alerts.telegram.tokenSet, cleared.json!.alerts.webhook.set], [false, false])
    assert.equal((await call('POST', '/seller/alerts/test', { channel: 'telegram' })).status, 409)
  } finally {
    await server.close()
  }
})

test('settings edits are validated, keep unknown fields and leave a backup', async () => {
  const { configPath, server, call } = await harness()
  try {
    const before = readFileSync(configPath, 'utf-8')
    const view = (await call('GET', '/seller/settings')).json!.settings
    assert.equal(view.writable, true)
    assert.deepEqual(view.services, [{ provider: 'openai', service: 'glm-5.3', inputUsdPerMillion: 1, outputUsdPerMillion: 3, cachedInputUsdPerMillion: null, inherited: false, paid: true, unitPrice: null, kind: 'text', apiProtocols: [], freeTier: null, ownFreeTier: null }])

    const saved = await call('PATCH', '/seller/settings', {
      displayName: 'Renamed', maxConcurrentBuyers: 20, gasCheck: { minBalanceEth: 0.001 }, restrictedCountries: ['ru', 'KP'],
      pricing: [{ provider: 'openai', service: 'glm-5.3', inputUsdPerMillion: 0.8, outputUsdPerMillion: 2.4, cachedInputUsdPerMillion: 0.1 }],
    })
    assert.equal(saved.status, 200, saved.text)
    assert.deepEqual(saved.json!.changed, ['displayName', 'maxConcurrentBuyers', 'gasCheck', 'restrictedCountries', 'pricing'])
    const after = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.equal(after.identity.displayName, 'Renamed')
    assert.equal(after.seller.maxConcurrentBuyers, 20)
    assert.deepEqual(after.seller.restrictedCountries, ['RU', 'KP'])
    assert.deepEqual(after.seller.providers.openai.services['glm-5.3'].pricing, { inputUsdPerMillion: 0.8, outputUsdPerMillion: 2.4, cachedInputUsdPerMillion: 0.1 })
    assert.deepEqual(after.seller.someFutureField, { kept: true })
    assert.equal(readFileSync(`${configPath}.bak`, 'utf-8'), before)

    for (const bad of [{ maxConcurrentBuyers: 0 }, { pricing: [{ provider: 'openai', service: 'nope', inputUsdPerMillion: 1, outputUsdPerMillion: 1 }] }, { restrictedCountries: ['RUS'] }, { upstreamApiKey: 'x' }]) {
      assert.equal((await call('PATCH', '/seller/settings', bad)).status, 400, JSON.stringify(bad))
    }
    assert.equal(JSON.parse(readFileSync(configPath, 'utf-8')).seller.maxConcurrentBuyers, 20, 'a refused edit writes nothing')
  } finally {
    await server.close()
  }
})

test('two dashboards on one host keep their own sessions in a shared cookie jar', async () => {
  const first = await harness()
  const second = await harness()
  try {
    // The browser sends every cookie for the host to either port.
    const jar = `${first.cookie}; ${second.cookie}`
    for (const dashboard of [first, second]) assert.equal((await dashboard.call('GET', '/auth/me', undefined, { cookie: jar })).status, 200)
  } finally {
    await first.server.close()
    await second.server.close()
  }
})

test('closing the dashboard does not wait for a stalled request', async () => {
  const { server, link } = await harness()
  const socket = connect(Number(link.port), link.hostname)
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  // Half a request: the server waits for the rest.
  socket.write('GET /console/api/auth/me HTTP/1.1\r\nHost: x\r\n')
  socket.on('error', () => {})
  const started = Date.now()
  await server.close()
  assert.ok(Date.now() - started < 1_000, 'closed without waiting for the stalled request')
  socket.destroy()
})

test('a restart is offered only with a supervisor, runs after the reply, and the session survives a dashboard served again under the same link', async () => {
  let restarts = 0
  const { server, dir, configPath, call, cookie } = await harness({ restart: { unavailableReason: null, run: () => { restarts += 1 } } })
  const token = linkToken(server.url)
  try {
    assert.deepEqual((await call('GET', '/seller/settings')).json!.restart, { available: true, reason: null })
    const response = await call('POST', '/seller/restart')
    assert.equal(response.status, 202)
    assert.equal(restarts, 0, 'not before the reply')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(restarts, 1)
  } finally {
    await server.close()
  }
  // The seller came back and serves the dashboard under the link it kept: the browser's session still works.
  const again = await startSellerDashboard({ dataDir: dir, configPath, version: '9.9.9', port: 0, env: {}, token })
  try {
    assert.equal(linkToken(again.url), token)
    const me = await fetch(`${new URL(again.url).origin}/console/api/auth/me`, { headers: { cookie } })
    assert.equal(me.status, 200)
  } finally {
    await again.close()
  }
  // A dashboard with a new link does not take the old session.
  const fresh = await startSellerDashboard({ dataDir: dir, configPath, version: '9.9.9', port: 0, env: {} })
  try {
    assert.equal((await fetch(`${new URL(fresh.url).origin}/console/api/auth/me`, { headers: { cookie } })).status, 401)
  } finally {
    await fresh.close()
  }
})

test('without a supervisor the dashboard says how to apply saved settings and refuses a restart', async () => {
  const { server, call } = await harness({ restart: { unavailableReason: 'Restart it where it runs.' } })
  try {
    assert.deepEqual((await call('GET', '/seller/settings')).json!.restart, { available: false, reason: 'Restart it where it runs.' })
    const response = await call('POST', '/seller/restart')
    assert.equal(response.status, 409)
    assert.equal(response.json!.error.code, 'restart_unavailable')
  } finally {
    await server.close()
  }
})
