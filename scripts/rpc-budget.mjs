#!/usr/bin/env node
/**
 * Chain-RPC budget of a buyer + gateway (console on), measured at the wire.
 *
 * Runs a counting JSON-RPC proxy, points `antseed buyer start` and
 * `antseed gateway start` at it through ANTSEED_BASE_RPC_URL, creates N
 * workspaces (each one a buyer wallet), restarts the buyer so every wallet
 * loads at startup, then reports:
 *   - the startup burst,
 *   - idle background calls per minute,
 *   - calls per console page view (overview, wallet, rewards, network), and
 *     per minute while the wallet page stays open (its deposit watcher is
 *     then in active mode).
 *
 * The proxy forwards to a local fake chain by default (it answers balances,
 * Multicall3 and zero for everything else), or to `--upstream <url>` (a
 * real RPC; mind its rate limits). Nothing is reused: the data dir lives in
 * a temp directory that is removed afterwards.
 *
 * Usage: pnpm run build && node scripts/rpc-budget.mjs [--workspaces 10] [--idle-seconds 120]
 *          [--open-seconds 60] [--upstream <url>] [--verbose] [--keep]
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = process.env['ANTSEED_CLI'] ?? join(root, 'apps/cli/dist/cli/index.js')
const { Wallet } = createRequire(join(root, 'apps/cli/package.json'))('ethers')

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const workspaceCount = Number(flag('workspaces', '10'))
const idleSeconds = Number(flag('idle-seconds', '120'))
const openSeconds = Number(flag('open-seconds', '60'))
const upstreamFlag = flag('upstream', null)
const keep = process.argv.includes('--keep')
/** Name each eth_call's target and selector in the breakdown. */
const verbose = process.argv.includes('--verbose')

const dataDir = mkdtempSync(join(tmpdir(), 'antseed-rpc-budget-'))
const configPath = join(dataDir, 'config.json')
const buyerPort = 20000 + Math.floor(Math.random() * 20000)
const gatewayPort = buyerPort + 1
const base = `http://127.0.0.1:${gatewayPort}`
const children = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── Counting proxy ──
const calls = [] // { at, method }
let upstreamUrl = upstreamFlag
let fake = null
const proxy = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8')
    let methods = ['?']
    try {
      const parsed = JSON.parse(body)
      methods = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => verbose && entry.method === 'eth_call'
        ? `eth_call(${String(entry.params?.[0]?.to).slice(0, 8)}:${String(entry.params?.[0]?.data).slice(0, 10)})`
        : entry.method)
    } catch {}
    calls.push({ at: Date.now(), method: methods.join('+') })
    try {
      const response = await fetch(upstreamUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      const text = await response.text()
      res.writeHead(response.status, { 'content-type': 'application/json', ...(response.headers.get('retry-after') ? { 'retry-after': response.headers.get('retry-after') } : {}) })
      res.end(text)
    } catch (error) {
      res.writeHead(502).end(String(error))
    }
  })
})

function between(from, to = Date.now()) {
  return calls.filter((call) => call.at >= from && call.at < to)
}
function describe(list) {
  const byMethod = {}
  for (const call of list) byMethod[call.method] = (byMethod[call.method] ?? 0) + 1
  return Object.entries(byMethod).map(([method, count]) => `${method}×${count}`).join(', ') || '—'
}

function startCli(name, args, env) {
  const child = spawn(process.execPath, [cli, '--data-dir', dataDir, '--config', configPath, ...args], {
    env: { ...process.env, ...env, ANTSEED_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const entry = { name, child, output: () => output }
  children.push(entry)
  return entry
}

async function stopChild(entry) {
  if (entry.child.exitCode !== null) return
  const exited = new Promise((resolve) => entry.child.once('exit', resolve))
  entry.child.kill('SIGINT')
  await Promise.race([exited, sleep(15_000)])
  if (entry.child.exitCode === null) entry.child.kill('SIGKILL')
}

async function waitFor(url, ok, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (ok(response.status)) return response.status
    } catch {}
    await sleep(250)
  }
  return null
}

const jar = { cookie: '' }
async function api(method, path, body) {
  const response = await fetch(`${base}/console/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-antseed-console': '1' } : {}),
      ...(jar.cookie ? { cookie: jar.cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) jar.cookie = setCookie.split(';')[0]
  const text = await response.text()
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = text }
  return { status: response.status, body: json }
}

const rows = []
function report(name, list, minutes = null) {
  const value = minutes ? `${(list.length / minutes).toFixed(2)}/min` : String(list.length)
  rows.push({ name, value, detail: describe(list) })
  console.log(`${name.padEnd(46)} ${value.padStart(10)}   ${describe(list)}`)
}

/** Runs one "page view" (its API calls in parallel) and counts the RPC calls in the next `settleMs`. */
async function pageView(name, requests, settleMs = 2_000) {
  const start = Date.now()
  const responses = await Promise.all(requests.map(([method, path, body]) => api(method, path, body)))
  await sleep(settleMs)
  const failed = responses.map((response, index) => [requests[index][1], response.status]).filter(([, status]) => status >= 400)
  report(`page view: ${name}`, between(start))
  if (failed.length) console.log(`  (non-2xx: ${failed.map(([path, status]) => `${path} ${status}`).join(', ')})`)
}

async function main() {
  if (!upstreamUrl) {
    const support = await import(pathToFileURL(join(root, 'apps/cli/dist/proxy/chain-rpc-test-support.js')).href)
    fake = await support.startFakeChainRpc({ evmChainId: 8453 })
    upstreamUrl = fake.url
  }
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const rpcUrl = `http://127.0.0.1:${proxy.address().port}`
  const env = { ANTSEED_BASE_RPC_URL: rpcUrl }
  console.log(`data dir ${dataDir}; RPC ${rpcUrl} → ${upstreamFlag ? upstreamFlag.replace(/\/\/([^/]+)\/.*/, '//$1/…') : 'fake chain'}`)

  let buyer = startCli('buyer', ['buyer', 'start', '--port', String(buyerPort), '--no-verifier'], env)
  if (await waitFor(`http://127.0.0.1:${buyerPort}/_antseed/buyer-identities`, (status) => status === 200, 90_000) !== 200) throw new Error(`buyer did not start:\n${buyer.output()}`)
  const gateway = startCli('gateway', ['gateway', 'start', '--port', String(gatewayPort), '--buyer-port', String(buyerPort)], env)
  if (await waitFor(`${base}/v1/models`, (status) => status === 401, 30_000) !== 401) throw new Error(`gateway did not start:\n${gateway.output()}`)

  // Claim the console as an owner signing in with a wallet.
  const link = JSON.parse(execFileSync(process.execPath, [cli, '--data-dir', dataDir, '--config', configPath, 'gateway', 'console-link', '--json'], { encoding: 'utf8', env: { ...process.env, ...env, ANTSEED_DATA_DIR: dataDir } }))
  const setup = await api('POST', '/auth/setup', { token: link.setupLink.split('#')[1], label: 'Budget owner', email: 'owner@example.test' })
  const owner = Wallet.createRandom()
  const nonce = await api('POST', '/auth/wallet/nonce', { address: owner.address })
  const signedIn = await api('POST', '/auth/wallet/verify', { message: nonce.body.message, signature: await owner.signMessage(nonce.body.message), enrollment: setup.body.enrollment })
  if (signedIn.status !== 200) throw new Error(`sign-in failed: HTTP ${signedIn.status}`)
  for (let index = 1; index < workspaceCount; index++) {
    const created = await api('POST', '/workspaces', { name: `Budget ${index}` })
    if (created.status !== 201) throw new Error(`workspace ${index}: HTTP ${created.status} ${JSON.stringify(created.body)}`)
  }
  const workspaces = (await api('GET', '/workspaces')).body
  const ws = workspaces[0].id
  console.log(`${workspaces.length} workspaces; restarting the buyer so every wallet loads at startup\n`)

  await stopChild(buyer)
  const startedAt = Date.now()
  buyer = startCli('buyer', ['buyer', 'start', '--port', String(buyerPort), '--no-verifier'], env)
  if (await waitFor(`http://127.0.0.1:${buyerPort}/_antseed/buyer-identities`, (status) => status === 200, 90_000) !== 200) throw new Error(`buyer did not restart:\n${buyer.output()}`)
  await sleep(30_000)
  report(`buyer startup, first ~30 s (${workspaces.length} wallets)`, between(startedAt))

  const idleStart = Date.now()
  await sleep(idleSeconds * 1000)
  report(`idle background, buyer + gateway (${workspaces.length} wallets)`, between(idleStart), idleSeconds / 60)

  await pageView('overview', [['GET', '/auth/me'], ['GET', '/workspaces'], ['GET', `/workspaces/${ws}`], ['GET', `/workspaces/${ws}/wallet`], ['GET', '/status'], ['GET', '/usage?groupBy=day'], ['GET', '/usage?groupBy=key'], ['GET', '/usage?groupBy=model']])
  await sleep(16_000) // let the 15 s balance cache expire, as between real page visits
  await pageView('wallet (cold balance cache)', [['GET', `/workspaces/${ws}/wallet`], ['GET', '/chain'], ['GET', `/workspaces/${ws}/channels`], ['GET', `/workspaces/${ws}/wallet/operator`], ['POST', `/workspaces/${ws}/wallet/watch`, { mode: 'active' }]])
  const openStart = Date.now()
  for (let elapsed = 0; elapsed < openSeconds; elapsed += 30) {
    await sleep(Math.min(30, openSeconds - elapsed) * 1000)
    await api('GET', `/workspaces/${ws}/wallet`) // the page's 30 s poll
  }
  report('wallet page left open (active watcher + 30 s poll)', between(openStart), openSeconds / 60)
  await api('POST', `/workspaces/${ws}/wallet/watch`, { mode: 'background' })
  await pageView('wallet (warm, within 15 s)', [['GET', `/workspaces/${ws}/wallet`], ['GET', '/chain'], ['GET', `/workspaces/${ws}/channels`], ['GET', `/workspaces/${ws}/wallet/operator`]])
  await pageView('rewards (cold)', [['GET', `/workspaces/${ws}/rewards`], ['GET', '/chain']], 3_000)
  await pageView('rewards (again, cached)', [['GET', `/workspaces/${ws}/rewards`], ['GET', '/chain']])
  await pageView('network', [['GET', '/peers'], ['GET', '/peer-lists'], ['GET', `/route-preview?model=qwen3-coder&workspace=${ws}`]])
  await pageView('all workspaces\' wallets (10 views)', workspaces.map((entry) => ['GET', `/workspaces/${entry.id}/wallet`]))

  const total = calls.length
  console.log(`\n${total} RPC requests in ${((Date.now() - startedAt) / 60_000).toFixed(1)} min since the buyer restart (all methods: ${describe(calls.filter((call) => call.at >= startedAt))})`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  for (const entry of [...children].reverse()) await stopChild(entry)
  proxy.close()
  await fake?.close()
  if (!keep) rmSync(dataDir, { recursive: true, force: true })
}
