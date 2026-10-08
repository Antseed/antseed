#!/usr/bin/env node
/**
 * End-to-end smoke test of the gateway console against the built CLI.
 *
 * Starts `antseed buyer start` and `antseed gateway start` (console on) on
 * a fresh temporary data dir, then drives the console API the way the web
 * app does: claim the console with a setup link, sign in with a wallet
 * (EIP-4361), create a workspace, invite a member, create a key and give it
 * a routing policy, read usage, requests, sellers, a route preview, the
 * workspace wallet and settings, use a management token, and check that a
 * disallowed model gets `403 model_not_allowed`. Also: the invited member
 * signs in from a second "browser" and sees only their workspace; org vs
 * workspace routing policy (incl. requireTee) and who may set each;
 * owner-only operator authorization and confirming a session
 * (`/auth/reauth/*`, which refuses another member's wallet); management
 * token expiry; the audit log; the request log's opaque cursor, search,
 * request detail and CSV export; buyer settings reporting `restartRequired`
 * when the buyer is not supervised; key layers (a member edits only the
 * owner layer of their key), 409 `narrowed` and 400 `empty_allow_list`.
 * Also checks that the web app's client-side routes load index.html and
 * its assets carry the CSP.
 *
 * Nothing is committed or reused: the data dir and every secret live in a
 * temp directory that is removed afterwards. The buyer may find no peers
 * offline; chain reads (the wallet) may then fail, which is reported and
 * tolerated.
 *
 * Usage: pnpm run build && node scripts/gateway-console-smoke.mjs [--keep]
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'apps/cli/dist/cli/index.js')
const { Wallet } = createRequire(join(root, 'apps/cli/package.json'))('ethers')

const keep = process.argv.includes('--keep')
const dataDir = mkdtempSync(join(tmpdir(), 'antseed-console-smoke-'))
const configPath = join(dataDir, 'config.json')
const buyerPort = 20000 + Math.floor(Math.random() * 20000)
const gatewayPort = buyerPort + 1
const base = `http://127.0.0.1:${gatewayPort}`
const children = []
const results = []

function check(name, ok, detail = '', { optional = false } = {}) {
  results.push({ name, ok, detail, optional })
  const mark = ok ? 'PASS' : optional ? 'NOTE' : 'FAIL'
  console.log(`${mark}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function startCli(name, args) {
  const child = spawn(process.execPath, [cli, '--data-dir', dataDir, '--config', configPath, ...args], {
    env: { ...process.env, ANTSEED_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  children.push({ name, child, output: () => output })
  return child
}

function runCli(args) {
  return execFileSync(process.execPath, [cli, '--data-dir', dataDir, '--config', configPath, ...args], { encoding: 'utf8' })
}

async function waitFor(url, ok, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (ok(response.status)) return response.status
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return null
}

/** A cookie jar per "browser". */
const ownerJar = { cookie: '' }
async function api(method, path, body, headers = {}, jar = ownerJar) {
  const response = await fetch(`${base}/console/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' && !headers.authorization ? { 'x-antseed-console': '1' } : {}),
      ...(jar.cookie && !headers.authorization ? { cookie: jar.cookie } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie && !headers.authorization) jar.cookie = setCookie.split(';')[0]
  const text = await response.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = text }
  return { status: response.status, body: json, headers: response.headers }
}

/** EIP-4361 sign-in (or, with `reauth`, confirmation of the jar's session) with a wallet. */
async function walletAuth(wallet, jar, { enrollment, reauth = false } = {}) {
  const prefix = reauth ? '/auth/reauth/wallet' : '/auth/wallet'
  const nonce = await api('POST', `${prefix}/nonce`, { address: wallet.address }, {}, jar)
  if (nonce.status !== 200) return nonce
  const signature = await wallet.signMessage(nonce.body.message)
  return api('POST', `${prefix}/verify`, { message: nonce.body.message, signature, ...(enrollment ? { enrollment } : {}) }, {}, jar)
}

const errorCode = (response) => response.body?.error?.code ?? ''

async function main() {
  console.log(`data dir ${dataDir}, buyer :${buyerPort}, gateway :${gatewayPort}`)
  startCli('buyer', ['buyer', 'start', '--port', String(buyerPort), '--no-verifier'])
  const buyerUp = await waitFor(`http://127.0.0.1:${buyerPort}/_antseed/buyer-identities`, (status) => status === 200, 90_000)
  check('buyer starts', buyerUp === 200, buyerUp ? '' : 'not reachable within 90 s; continuing (policy checks do not need it)', { optional: true })

  startCli('gateway', ['gateway', 'start', '--port', String(gatewayPort), '--buyer-port', String(buyerPort)])
  const gatewayUp = await waitFor(`${base}/v1/models`, (status) => status === 401, 30_000)
  check('gateway answers 401 without a key', gatewayUp === 401)
  if (gatewayUp !== 401) throw new Error('gateway did not start')

  // ── Web app ──
  const index = await fetch(`${base}/console`)
  const built = index.status === 200
  check('GET /console', built || index.status === 503, `HTTP ${index.status}${built ? '' : ' (console web app not built)'}`)
  if (built) {
    const html = await index.text()
    const csp = index.headers.get('content-security-policy') ?? ''
    check('console sets a CSP allowing wallet RPC/WalletConnect', /connect-src[^;]*https:[^;]*wss:/.test(csp) && /frame-ancestors 'none'/.test(csp), csp.slice(0, 60))
    const deep = await fetch(`${base}/console/keys`)
    const deepHtml = await deep.text()
    check('GET /console/keys serves index.html (SPA fallback)', deep.status === 200 && deepHtml === html && (deep.headers.get('content-type') ?? '').includes('text/html'))
    const asset = /(?:src|href)="(\/console\/assets\/[^"]+\.js)"/.exec(html)?.[1]
    if (asset) {
      const response = await fetch(`${base}${asset}`)
      check('assets load with JS type, CSP and immutable caching', response.status === 200
        && (response.headers.get('content-type') ?? '').includes('javascript')
        && Boolean(response.headers.get('content-security-policy'))
        && (response.headers.get('cache-control') ?? '').includes('immutable'), asset)
    } else {
      check('index.html references a script under /console/assets/', false)
    }
    const missing = await fetch(`${base}/console/assets/nope.js`)
    check('a missing asset is a 404, not the app shell', missing.status === 404)
  }

  // ── Claim the console ──
  const config = await api('GET', '/auth/config')
  check('GET /auth/config', config.status === 200 && config.body.setupRequired === true, JSON.stringify(config.body))
  const link = JSON.parse(runCli(['gateway', 'console-link', '--json']))
  check('console-link prints a localhost setup link', /^http:\/\/localhost:\d+\/console\/setup#/.test(link.setupLink ?? ''), link.setupLink?.replace(/#.*/, '#…'))
  const setup = await api('POST', '/auth/setup', { token: link.setupLink.split('#')[1], label: 'Smoke owner', email: 'owner@example.test' })
  check('POST /auth/setup', setup.status === 200 && typeof setup.body.enrollment === 'string', `HTTP ${setup.status}`)

  const owner = Wallet.createRandom()
  const nonce = await api('POST', '/auth/wallet/nonce', { address: owner.address })
  check('POST /auth/wallet/nonce (EIP-4361 message)', nonce.status === 200 && /wants you to sign in with your Ethereum account/.test(nonce.body.message ?? ''))
  const signature = await owner.signMessage(nonce.body.message)
  const signedIn = await api('POST', '/auth/wallet/verify', { message: nonce.body.message, signature, enrollment: setup.body.enrollment })
  check('wallet sign-in as owner', signedIn.status === 200 && signedIn.body.me?.member?.orgRole === 'owner', `HTTP ${signedIn.status}`)
  check('session cookie set', ownerJar.cookie.startsWith('antseed_console='))
  const ownerId = signedIn.body.me.member.id
  const reclaim = JSON.parse(runCli(['gateway', 'console-link', '--json']))
  check('console-link after setup prints the console URL', reclaim.setupRequired === false && /\/console$/.test(reclaim.url))

  // ── Organization ──
  const workspace = await api('POST', '/workspaces', { name: 'Smoke workspace', limits: { daily: null, weekly: '10', monthly: null, total: null } })
  check('create workspace', workspace.status === 201 && /^0x[0-9a-fA-F]{40}$/.test(workspace.body.walletAddress ?? ''), `HTTP ${workspace.status} ${workspace.body.id ?? ''}`)
  const wsId = workspace.body.id
  const invite = await api('POST', '/invites', { label: 'Smoke member', email: 'member@example.test', orgRole: 'member', workspaces: [{ workspaceId: wsId, role: 'member' }] })
  check('invite member', invite.status === 201 && /\/console\/invite#/.test(invite.body.url ?? ''), `HTTP ${invite.status}`)

  // ── The invited member, in a second browser ──
  const memberJar = { cookie: '' }
  const memberWallet = Wallet.createRandom()
  const accepted = await api('POST', '/auth/invite', { token: invite.body.url.split('#')[1] }, {}, memberJar)
  check('member accepts the invite', accepted.status === 200 && typeof accepted.body.enrollment === 'string', `HTTP ${accepted.status}`)
  const memberSignIn = await walletAuth(memberWallet, memberJar, { enrollment: accepted.body.enrollment })
  check('member signs in with their own wallet', memberSignIn.status === 200 && memberSignIn.body.me?.member?.orgRole === 'member', `HTTP ${memberSignIn.status}`)
  const memberWorkspaces = await api('GET', '/workspaces', undefined, {}, memberJar)
  check('member sees only their workspace', memberWorkspaces.status === 200 && memberWorkspaces.body.length === 1 && memberWorkspaces.body[0].id === wsId,
    memberWorkspaces.status === 200 ? memberWorkspaces.body.map((w) => w.name).join(', ') : `HTTP ${memberWorkspaces.status}`)
  const memberOrgPolicy = await api('PATCH', `/workspaces/${wsId}`, { orgRoutingPolicy: { requireTee: false } }, {}, memberJar)
  check('member cannot set the org policy of a workspace', memberOrgPolicy.status === 403, `HTTP ${memberOrgPolicy.status} ${errorCode(memberOrgPolicy)}`)
  const memberAudit = await api('GET', '/audit', undefined, {}, memberJar)
  check('member cannot read the audit log', memberAudit.status === 403, `HTTP ${memberAudit.status}`)
  const memberOperator = await api('POST', `/workspaces/${wsId}/wallet/operator-auth`, { operator: memberWallet.address }, {}, memberJar)
  check('only the owner may authorize an operator', memberOperator.status === 403 && errorCode(memberOperator) === 'forbidden', `HTTP ${memberOperator.status} ${errorCode(memberOperator)}`)

  // ── Confirming a session (re-auth) and operator authorization ──
  const ownerCookie = ownerJar.cookie
  const wrongMember = await walletAuth(memberWallet, ownerJar, { reauth: true })
  check('re-auth with another member\'s wallet is refused', wrongMember.status === 403 && errorCode(wrongMember) === 'reauth_wrong_member' && ownerJar.cookie === ownerCookie,
    `HTTP ${wrongMember.status} ${errorCode(wrongMember)}`)
  const stillOwner = await api('GET', '/auth/me')
  check('…and the owner session is untouched', stillOwner.status === 200 && stillOwner.body.me?.member?.id === ownerId)
  const memberReauth = await walletAuth(owner, memberJar, { reauth: true })
  check('member cannot confirm with the owner\'s wallet', memberReauth.status === 403 && errorCode(memberReauth) === 'reauth_wrong_member', `HTTP ${memberReauth.status} ${errorCode(memberReauth)}`)
  const reauth = await walletAuth(owner, ownerJar, { reauth: true })
  check('owner confirms their session with their own wallet', reauth.status === 200 && reauth.body.me?.member?.id === ownerId && ownerJar.cookie === ownerCookie && !reauth.headers.get('set-cookie'),
    `HTTP ${reauth.status} ${errorCode(reauth)}`)
  const notYours = await api('POST', `/workspaces/${wsId}/wallet/operator-auth`, { operator: memberWallet.address })
  check('operator must be one of the owner\'s wallets', notYours.status === 403 && errorCode(notYours) === 'operator_not_yours', `HTTP ${notYours.status} ${errorCode(notYours)}`)
  // The owner's wallet sign-in was added moments ago, so it can't become the
  // operator until it is a day old (a stolen session can't add and use one).
  const operatorAuth = await api('POST', `/workspaces/${wsId}/wallet/operator-auth`, { operator: owner.address })
  check('a freshly added wallet cannot become the operator yet', operatorAuth.status === 403 && errorCode(operatorAuth) === 'operator_too_new', `HTTP ${operatorAuth.status} ${errorCode(operatorAuth)}`)

  // ── Org vs workspace routing policy ──
  const orgPolicy = await api('PATCH', `/workspaces/${wsId}`, { orgRoutingPolicy: { requireTee: true, maxInputUsdPerMillion: 5 } })
  const wsPolicy = await api('PATCH', `/workspaces/${wsId}`, { routingPolicy: { blockedPeerIds: ['0x00000000000000000000000000000000000000aa'], sort: 'latency' } })
  check('org and workspace policies are stored separately', orgPolicy.status === 200 && wsPolicy.status === 200
    && wsPolicy.body.orgRoutingPolicy?.requireTee === true && wsPolicy.body.routingPolicy?.blockedPeerIds?.length === 1 && wsPolicy.body.routingPolicy?.requireTee === undefined,
    `HTTP ${orgPolicy.status}/${wsPolicy.status}`)
  const wsPreview = await api('GET', `/route-preview?model=qwen3-coder&workspace=${wsId}`)
  check('route preview combines them (TEE-only, cap, block list)', wsPreview.status === 200 && wsPreview.body.policy?.requireTee === true
    && wsPreview.body.policy?.maxInputUsdPerMillion === 5 && wsPreview.body.policy?.blockedPeerIds?.length === 1
    && ['workspace-org', 'workspace'].every((level) => wsPreview.body.sources?.some((source) => source.level === level)),
  wsPreview.status === 200 ? wsPreview.body.sources.map((source) => source.level).join(' → ') : `HTTP ${wsPreview.status} ${errorCode(wsPreview)}`, { optional: !buyerUp })
  const badPolicy = await api('PATCH', `/workspaces/${wsId}`, { routingPolicy: { requireTee: 'yes' } })
  check('a malformed policy is refused', badPolicy.status === 400, `HTTP ${badPolicy.status} ${errorCode(badPolicy)}`)
  const key = await api('POST', '/keys', { label: 'Smoke key', workspaceId: wsId, limits: { daily: null, weekly: '5', monthly: null, total: null } })
  check('create key', key.status === 201 && /^antseed_/.test(key.body.secret ?? ''), `HTTP ${key.status}`)
  const keyId = key.body.key.id
  const patched = await api('PATCH', `/keys/${keyId}`, { routingPolicy: { allowedModels: ['qwen3-coder'], sort: 'price' } })
  check('PATCH key routing policy', patched.status === 200 && patched.body.routingPolicy?.allowedModels?.[0] === 'qwen3-coder', `HTTP ${patched.status}`)

  // ── Key layers: admins own a key's limits and policy, its owner only their own layer ──
  const memberKey = await api('POST', '/keys', { label: 'Member key', workspaceId: wsId, limits: { daily: '1' } }, {}, memberJar)
  check('a member\'s own key: their caps become its owner layer', memberKey.status === 201 && memberKey.body.key?.ownerLimits?.daily === '1.000000'
    && memberKey.body.key?.limits?.daily === null, `HTTP ${memberKey.status} ${errorCode(memberKey)}`)
  const memberKeyId = memberKey.body.key?.id
  const adminLayer = await api('PATCH', `/keys/${memberKeyId}`, { routingPolicy: null }, {}, memberJar)
  check('the key owner cannot change the admin layer', adminLayer.status === 403, `HTTP ${adminLayer.status} ${errorCode(adminLayer)}`)
  const wider = await api('PATCH', `/keys/${memberKeyId}`, { ownerRoutingPolicy: { maxInputUsdPerMillion: 50 } }, {}, memberJar)
  check('asking for more than the levels above allow is 409 narrowed', wider.status === 409 && errorCode(wider) === 'narrowed'
    && wider.body.error?.effectiveRoutingPolicy?.maxInputUsdPerMillion === 5, `HTTP ${wider.status} ${errorCode(wider)}`)
  const ownerLayer = await api('PATCH', `/keys/${memberKeyId}`, { ownerRoutingPolicy: { maxInputUsdPerMillion: 2 }, ownerLimits: { daily: '2' } }, {}, memberJar)
  check('the key owner sets their own layer freely', ownerLayer.status === 200 && ownerLayer.body.ownerLimits?.daily === '2.000000', `HTTP ${ownerLayer.status} ${errorCode(ownerLayer)}`)
  const emptyAllow = await api('PATCH', `/workspaces/${wsId}`, { routingPolicy: { allowedPeerIds: [] } })
  check('an allow list that leaves no seller needs confirmEmpty', emptyAllow.status === 400 && errorCode(emptyAllow) === 'empty_allow_list', `HTTP ${emptyAllow.status} ${errorCode(emptyAllow)}`)

  // ── Reads ──
  const usage = await api('GET', '/usage?groupBy=day')
  check('GET /usage', usage.status === 200 && usage.body.totals !== undefined)
  const requests = await api('GET', '/requests?status=success')
  check('GET /requests', requests.status === 200 && Array.isArray(requests.body.requests))
  const peers = await api('GET', '/peers')
  check('GET /peers', peers.status === 200 && Array.isArray(peers.body), peers.status === 200 ? `${peers.body.length} peer(s)` : `HTTP ${peers.status} ${peers.body?.error?.code ?? ''}`, { optional: !buyerUp })
  const preview = await api('GET', `/route-preview?model=qwen3-coder&key=${keyId}`)
  check('GET /route-preview', preview.status === 200 && preview.body.modelAllowed === true && preview.body.sources?.some((s) => s.level === 'key'),
    preview.status === 200 ? `${preview.body.candidates.length} candidate(s)` : `HTTP ${preview.status} ${preview.body?.error?.code ?? ''}`, { optional: !buyerUp })
  const blockedPreview = await api('GET', `/route-preview?model=llama-3.3-70b&key=${keyId}`)
  check('route preview reports a disallowed model', blockedPreview.status === 200 && blockedPreview.body.modelAllowed === false, '', { optional: !buyerUp })
  const wallet = await api('GET', `/workspaces/${wsId}/wallet`)
  check('GET /workspaces/:id/wallet', wallet.status === 200, wallet.status === 200 ? `available ${wallet.body.available}` : `HTTP ${wallet.status} ${wallet.body?.error?.code ?? ''} (needs the buyer and a chain RPC)`, { optional: true })
  const chain = await api('GET', '/chain')
  check('GET /chain has usdc, deposits and usageRewards', chain.status === 200 && ['usdc', 'deposits', 'usageRewards'].every((name) => chain.body.contracts?.[name]), chain.status === 200 ? chain.body.rpcUrl : `HTTP ${chain.status}`)
  const settings = await api('GET', '/settings')
  check('GET /settings', settings.status === 200 && settings.body.auth?.setupRequired === false)

  // ── Management token ──
  const token = await api('POST', '/admin-tokens', { label: 'smoke', scope: 'read', expiresInDays: 7 })
  check('create management token', token.status === 201 && /^antseed_admin_/.test(token.body.secret ?? ''), `HTTP ${token.status}`)
  const week = Date.now() + 7 * 86_400_000
  check('token expires after the requested days', Math.abs((token.body.token?.expiresAt ?? 0) - week) < 120_000, token.body.token?.expiresAt ? new Date(token.body.token.expiresAt).toISOString() : 'no expiresAt')
  const defaultToken = await api('POST', '/admin-tokens', { label: 'smoke default', scope: 'read' })
  check('tokens expire after 90 days by default', defaultToken.status === 201 && Math.abs(defaultToken.body.token.expiresAt - (Date.now() + 90 * 86_400_000)) < 120_000)
  const badExpiry = await api('POST', '/admin-tokens', { label: 'smoke bad', scope: 'read', expiresInDays: 0 })
  check('an out-of-range expiry is refused', badExpiry.status === 400, `HTTP ${badExpiry.status}`)
  const tokens = await api('GET', '/admin-tokens')
  check('GET /admin-tokens lists expiry', tokens.status === 200 && tokens.body.every((item) => 'expiresAt' in item), `${tokens.body?.length ?? 0} token(s)`)
  const bearer = { authorization: `Bearer ${token.body.secret}` }
  const tokenRead = await api('GET', '/usage?groupBy=model', undefined, bearer)
  check('read token can GET /usage', tokenRead.status === 200)
  const tokenWrite = await api('POST', '/workspaces', { name: 'nope' }, bearer)
  check('read token cannot write', tokenWrite.status === 403 && tokenWrite.body.error?.code === 'read_only_token', `HTTP ${tokenWrite.status}`)
  const noCsrf = await fetch(`${base}/console/api/workspaces`, { method: 'POST', headers: { cookie: ownerJar.cookie, 'content-type': 'application/json' }, body: '{"name":"x"}' })
  check('cookie writes without the CSRF header are refused', noCsrf.status === 403)

  // ── Policy enforcement on the API ──
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key.body.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'hi' }] }),
  })
  const chatBody = await chat.json().catch(() => ({}))
  check('disallowed model gets 403 model_not_allowed', chat.status === 403 && chatBody.error?.code === 'model_not_allowed', `HTTP ${chat.status} ${chatBody.error?.code ?? ''}`)
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key.body.secret}` } })
  check('GET /v1/models with the key', models.status === 200, `HTTP ${models.status}`)

  // An allowed model reaches the buyer; with the workspace TEE-only policy and
  // its price cap there is usually no eligible seller, so this fails without
  // spending, but it is logged either way.
  const routed = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key.body.secret}`, 'content-type': 'application/json', 'x-antseed-end-user': 'smoke-user' },
    body: JSON.stringify({ model: 'qwen3-coder', max_tokens: 8, messages: [{ role: 'user', content: 'Say ok.' }] }),
    signal: AbortSignal.timeout(90_000),
  }).catch((error) => ({ status: 0, text: async () => String(error) }))
  const routedBody = await routed.text()
  check('an allowed model is routed through the buyer', routed.status !== 0 && routed.status !== 403, `HTTP ${routed.status} ${routedBody.slice(0, 120)}`)

  // ── Request log: search, opaque cursor, detail, CSV ──
  const found = await api('GET', '/requests?q=smoke-user')
  const logged = found.body?.requests?.find((entry) => entry.model === 'qwen3-coder')
  check('request search finds it (by end user)', found.status === 200 && Boolean(logged) && logged.endUser === 'smoke-user',
    logged ? `${logged.tag} HTTP ${logged.status} ${logged.errorCode ?? ''}` : `HTTP ${found.status}, ${found.body?.requests?.length ?? 0} match(es)`)
  const firstPage = await api('GET', '/requests?limit=1')
  check('request pages carry an opaque string cursor', firstPage.status === 200 && (firstPage.body.nextBefore === null || typeof firstPage.body.nextBefore === 'string'), String(firstPage.body?.nextBefore))
  if (typeof firstPage.body?.nextBefore === 'string') {
    const nextPage = await api('GET', `/requests?limit=1&before=${encodeURIComponent(firstPage.body.nextBefore)}`)
    check('the cursor fetches the next page', nextPage.status === 200 && nextPage.body.requests.length === 1 && nextPage.body.requests[0].tag !== firstPage.body.requests[0].tag)
  }
  const badCursor = await api('GET', '/requests?before=not-a-cursor')
  check('a malformed cursor is refused', badCursor.status === 400, `HTTP ${badCursor.status}`)
  if (logged) {
    const detail = await api('GET', `/requests/${encodeURIComponent(logged.tag)}`)
    check('GET /requests/:tag (request detail)', detail.status === 200 && detail.body.tag === logged.tag && 'requestBody' in detail.body && 'responseBody' in detail.body, `HTTP ${detail.status}`)
  }
  const unknownDetail = await api('GET', '/requests/does-not-exist')
  check('unknown request detail is a 404', unknownDetail.status === 404, `HTTP ${unknownDetail.status}`)
  const csv = await fetch(`${base}/console/api/usage/export.csv`, { headers: { cookie: ownerJar.cookie } })
  const csvText = await csv.text()
  check('CSV export', csv.status === 200 && (csv.headers.get('content-type') ?? '').includes('text/csv') && csvText.split('\n').length >= 2, `${csvText.split('\n').filter(Boolean).length - 1} row(s)`)

  // ── Buyer settings ──
  const buyerSettings = await api('PATCH', '/settings/buyer', { minPeerReputation: 10 })
  check('buyer settings save, and report restartRequired when the buyer is not supervised', buyerSettings.status === 200 && buyerSettings.body.buyer?.minPeerReputation === 10 && buyerSettings.body.restartRequired === true,
    `HTTP ${buyerSettings.status} restartRequired=${buyerSettings.body?.restartRequired}`)

  // ── Audit log ──
  const audit = await api('GET', '/audit?limit=200')
  const actions = new Set((audit.body?.entries ?? []).map((entry) => entry.action))
  const expected = ['auth.sign_in', 'auth.reauth', 'auth.reauth_failed', 'workspace.create', 'key.create', 'token.create', 'wallet.operator_auth.denied']
  check('audit log records the actions', audit.status === 200 && expected.every((action) => actions.has(action)),
    `missing: ${expected.filter((action) => !actions.has(action)).join(', ') || 'none'}; ${actions.size} distinct action(s)`)
  const keyAudit = await api('GET', '/audit?action=key')
  check('audit filter by action family', keyAudit.status === 200 && keyAudit.body.entries.length > 0 && keyAudit.body.entries.every((entry) => entry.action.startsWith('key.')))
  const auditPage = await api('GET', '/audit?limit=2')
  check('audit pages carry a string cursor', auditPage.status === 200 && typeof auditPage.body.nextBefore === 'string')
  const tokenAudit = await api('GET', '/audit', undefined, bearer)
  check('management tokens can read the audit log', tokenAudit.status === 200, `HTTP ${tokenAudit.status}`)
}

async function shutdown() {
  for (const { child } of children.reverse()) child.kill('SIGINT')
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL')
  if (!keep) rmSync(dataDir, { recursive: true, force: true })
}

let failed = false
try {
  await main()
} catch (error) {
  failed = true
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  for (const { name, output } of children) console.error(`--- ${name} output (tail) ---\n${output().split('\n').slice(-30).join('\n')}`)
} finally {
  await shutdown()
}
const failures = results.filter((result) => !result.ok && !result.optional)
console.log(`\n${results.filter((result) => result.ok).length} passed, ${failures.length} failed, ${results.filter((result) => !result.ok && result.optional).length} noted`)
process.exit(failed || failures.length > 0 ? 1 : 0)
