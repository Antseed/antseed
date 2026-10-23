import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test, { type TestContext } from 'node:test'
import { Command } from 'commander'
import type { PeerInfo } from '@antseed/node'
import type { PostHogEvent } from '@antseed/telemetry'
import { BuyerProxy } from '../proxy/buyer-proxy.js'
import { BuyerTelemetry, RequestTrace, publicModelId, telemetryClientTool } from './buyer.js'
import { beginCommandRun, commandPath } from './command.js'
import { GatewayTelemetry } from './gateway.js'
import { readConfiguredTelemetry, resolveCliConsent, writeConfiguredTelemetry } from './settings.js'
import { createProgram } from '../cli/program.js'

const WALLET = '0x1111111111111111111111111111111111111111'
const CONFIGURED = { POSTHOG_HOST: 'https://posthog.example.com', POSTHOG_PROJECT_API_KEY: 'phc_test' }
const SECRET_PEER = 'abcdef0123456789abcdef0123456789abcdef01'

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-telemetry-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  return dir
}

function capture(): { events: PostHogEvent[]; sender: (batch: PostHogEvent[]) => Promise<void> } {
  const events: PostHogEvent[] = []
  return { events, sender: async (batch) => { events.push(...batch) } }
}

test('consent: default on when configured; config opt-out, DO_NOT_TRACK and CI turn it off', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'config.json')
  assert.equal(resolveCliConsent(configPath, {}).enabled, false, 'source builds bake no project')
  assert.equal(resolveCliConsent(configPath, CONFIGURED).enabled, true)
  assert.equal(resolveCliConsent(configPath, { ...CONFIGURED, DO_NOT_TRACK: '1' }).enabled, false)
  assert.equal(resolveCliConsent(configPath, { ...CONFIGURED, ANTSEED_TELEMETRY: '0' }).enabled, false)
  assert.equal(resolveCliConsent(configPath, { ...CONFIGURED, CI: 'true' }).enabled, false)

  await writeFile(configPath, JSON.stringify({ buyer: { proxyPort: 9999 } }))
  writeConfiguredTelemetry(configPath, false)
  assert.equal(readConfiguredTelemetry(configPath), false)
  assert.deepEqual(resolveCliConsent(configPath, CONFIGURED), { enabled: false, reason: 'user_disabled' })
  const written = JSON.parse(await readFile(configPath, 'utf8'))
  assert.deepEqual(written, { buyer: { proxyPort: 9999 }, telemetry: { enabled: false } }, 'other keys untouched, no defaults written')
})

test('command names come from the command tree, never argv', () => {
  const program = createProgram()
  const buyer = program.commands.find((command) => command.name() === 'buyer')!
  const start = buyer.commands.find((command) => command.name() === 'start')!
  assert.equal(commandPath(start), 'buyer start')
  const telemetry = program.commands.find((command) => command.name() === 'telemetry')!
  assert.deepEqual(telemetry.commands.map((command) => command.name()).sort(), ['disable', 'enable', 'status'])
})

test('cli_command_run: one notice, then events with no arguments', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'config.json')
  const program = new Command().name('antseed')
  const deposit = program.command('deposit').argument('<amount>')
  const out: string[] = []
  const stream = { isTTY: true, write: (text: string) => { out.push(text); return true } } as unknown as NodeJS.WriteStream
  const { events, sender } = capture()
  const argv = ['node', 'antseed', 'deposit', '12.345678', '--secret-flag']

  const first = beginCommandRun({ configPath, dataDir: dir, command: deposit, argv, env: CONFIGURED, stream, sender })
  assert.ok(first)
  assert.match(out.join(''), /antseed telemetry disable/)
  await first.finish('success')
  // No wallet in this data dir: nothing is sent.
  assert.equal(events.length, 0)

  await writeFile(join(dir, 'identity.key'), '11'.repeat(32))
  const second = beginCommandRun({ configPath, dataDir: dir, command: deposit, argv, env: CONFIGURED, stream, sender })
  assert.equal(out.length, 1, 'the notice shows once')
  await second!.finish('failed')
  assert.equal(events.length, 1)
  const props = events[0]!.properties
  assert.equal(events[0]!.event, 'cli_command_run')
  assert.equal(props['command'], 'deposit')
  assert.equal(props['outcome'], 'failed')
  assert.equal(props['product'], 'cli')
  assert.equal(props['is_first_run'], false)
  assert.equal(JSON.stringify(events).includes('12.345678'), false)
  assert.equal(JSON.stringify(events).includes('secret'), false)
})

test('cli_command_run: silent without a terminal before the notice, and when a host runs the CLI', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'config.json')
  const program = new Command().name('antseed')
  const status = program.command('status')
  const stream = { isTTY: false, write: () => true } as unknown as NodeJS.WriteStream
  assert.equal(beginCommandRun({ configPath, dataDir: dir, command: status, argv: [], env: CONFIGURED, stream }), null)
  const tty = { isTTY: true, write: () => true } as unknown as NodeJS.WriteStream
  assert.equal(beginCommandRun({ configPath, dataDir: dir, command: status, argv: [], env: { ...CONFIGURED, ANTSEED_TELEMETRY_HOST: 'desktop' }, stream: tty }), null)
  assert.equal(beginCommandRun({ configPath, dataDir: dir, command: status, argv: ['--json'], env: CONFIGURED, stream: tty }), null)
})

test('request trace: failure taxonomy, fallbacks and buckets', () => {
  const trace = new RequestTrace(1_000, true)
  trace.protocol = 'openai-chat-completions'
  trace.model = 'gpt-5'
  trace.noteAttempt(SECRET_PEER)
  trace.noteAttempt('2'.repeat(40))
  trace.noteFailure({ statusCode: 502, responseBody: Buffer.from(`P2P request failed: Connection to ${SECRET_PEER} failed`), errorMessage: null })
  const props = trace.finish(502, false, 4_000)!
  assert.equal(props['outcome'], 'failed')
  assert.equal(props['failure_reason'], 'seller_unreachable')
  assert.equal(props['http_status'], 502)
  assert.equal(props['sellers_tried'], '2')
  assert.equal(props['fell_back'], true)
  assert.equal(props['public_model_id'], 'gpt-5')
  assert.equal(JSON.stringify(props).includes(SECRET_PEER), false)
  assert.equal(trace.finish(502, false, 5_000), null, 'reported once')

  assert.equal(publicModelId('my-private-finetune-xyz'), 'custom_or_unknown')
  assert.equal(telemetryClientTool('claude-code'), 'claude-code')
  assert.equal(telemetryClientTool('my-secret-tool'), 'custom')
})

function makePeer(): PeerInfo {
  return {
    peerId: SECRET_PEER as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: ['openai'],
    reputationScore: 80,
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'gpt-5': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } },
    providerServiceApiProtocols: { openai: { services: { 'gpt-5': ['openai-chat-completions'] } } },
  } as unknown as PeerInfo
}

/** A response that, like a Node ServerResponse, emits `close` once it ends. */
class FakeResponse extends EventEmitter {
  statusCode = 0
  headersSent = false
  writableEnded = false
  writableFinished = false
  body = ''
  writeHead(statusCode: number) { this.statusCode = statusCode; this.headersSent = true; return this }
  setHeader() { return this }
  write(chunk: string | Uint8Array) { this.body += Buffer.from(chunk).toString(); return true }
  end(chunk?: string | Uint8Array) {
    if (chunk !== undefined) this.write(chunk)
    this.writableEnded = true
    this.writableFinished = true
    queueMicrotask(() => this.emit('close'))
    return this
  }
}

function request(body: object, headers: Record<string, string> = {}): Readable {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & Record<string, unknown>
  req['method'] = 'POST'
  req['url'] = '/v1/chat/completions'
  req['headers'] = { 'content-type': 'application/json', 'user-agent': 'claude-code/1.0', ...headers }
  req['complete'] = true
  return req
}

async function proxyWithTelemetry(t: TestContext, env: NodeJS.ProcessEnv, status: number) {
  const dir = await tempDir(t)
  const { events, sender } = capture()
  const telemetry = new BuyerTelemetry({ configPath: join(dir, 'config.json'), getDistinctId: () => WALLET, env: { ...CONFIGURED, ...env }, sender })
  const peer = makePeer()
  const forwarded: Record<string, string>[] = []
  const proxy = new BuyerProxy({
    adaptiveRouting: { spreadTolerance: 0, explorationRate: 0 },
    port: 0,
    dataDir: dir,
    telemetry,
    node: {
      router: { allowsPeerForPolicy: () => true, onResult: () => {} },
      sendRequest: async (_peer: PeerInfo, req: { requestId: string; headers: Record<string, string> }) => {
        forwarded.push(req.headers)
        return { requestId: req.requestId, statusCode: status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(status < 400 ? { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } : { error: { message: 'upstream failed' } })) }
      },
    } as never,
  })
  ;(proxy as any)._getPeers = async () => [peer]
  ;(proxy as any)._cachedPeers = [peer]
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  return { proxy, telemetry, events, forwarded }
}

async function send(proxy: BuyerProxy, req: Readable): Promise<FakeResponse> {
  const res = new FakeResponse()
  await (proxy as any)._handleRequest(req, res)
  await new Promise((resolve) => setImmediate(resolve))
  return res
}

test('buyer_request_finished: one per request, enums only, nothing added to what a seller receives', async (t) => {
  const { proxy, telemetry, events, forwarded } = await proxyWithTelemetry(t, {}, 200)
  const res = await send(proxy, request({ model: 'gpt-5', messages: [{ role: 'user', content: 'my secret prompt' }] }))
  assert.equal(res.statusCode, 200)
  await telemetry.close()
  const finished = events.filter((event) => event.event === 'buyer_request_finished')
  assert.equal(finished.length, 1)
  const props = finished[0]!.properties
  assert.equal(props['product'], 'buyer')
  assert.equal(props['buyer_host'], 'standalone')
  assert.equal(props['outcome'], 'success')
  assert.equal(props['failure_reason'], 'none')
  assert.equal(props['protocol'], 'openai-chat-completions')
  assert.equal(props['public_model_id'], 'gpt-5')
  assert.equal(props['route_mode'], 'auto')
  assert.equal(props['client_tool'], 'claude-code')
  assert.equal(props['sellers_tried'], '1')
  assert.equal(props['seller_tier'], 'paid')
  assert.equal('$geoip_disable' in props, false)
  const body = JSON.stringify(events)
  assert.equal(body.includes('my secret prompt'), false)
  assert.equal(body.includes(SECRET_PEER), false)
  assert.equal(forwarded.length, 1)
  assert.equal(Object.keys(forwarded[0]!).some((name) => name.includes('telemetry')), false)
})

test('a gateway buyer sends one event per journey request, skips routine successes, no GeoIP', async (t) => {
  const { proxy, telemetry, events } = await proxyWithTelemetry(t, { ANTSEED_TELEMETRY_HOST: 'gateway' }, 503)
  await send(proxy, request({ model: 'gpt-5', messages: [] }))
  await send(proxy, request({ model: 'gpt-5', messages: [] }))
  await telemetry.close()
  const finished = events.filter((event) => event.event === 'buyer_request_finished')
  assert.equal(finished.length, 2, 'every failure is its own event')
  for (const event of finished) {
    assert.equal(event.properties['outcome'], 'failed')
    assert.equal(event.properties['failure_reason'], 'seller_5xx')
    assert.equal(event.properties['journey_moment'], 'failure')
    assert.equal(event.properties['buyer_host'], 'gateway')
    assert.equal(event.properties['$geoip_disable'], true)
  }
})

test('journey moments: first success, routine success skipped, recovery and fallback', () => {
  const telemetry = new BuyerTelemetry({ configPath: null, getDistinctId: () => WALLET, env: { ...CONFIGURED, ANTSEED_TELEMETRY_HOST: 'gateway' } })
  const ok = { outcome: 'success', fell_back: false }
  assert.equal(telemetry.journeyMoment(ok), 'first_success')
  assert.equal(telemetry.journeyMoment(ok), null)
  assert.equal(telemetry.journeyMoment({ outcome: 'failed' }), 'failure')
  assert.equal(telemetry.journeyMoment(ok), 'recovered')
  assert.equal(telemetry.journeyMoment({ outcome: 'success', fell_back: true }), 'fell_back')
  assert.equal(telemetry.journeyMoment({ outcome: 'cancelled' }), 'cancelled')
  assert.equal(telemetry.journeyMoment(ok), null)
})

test('turning telemetry off in the config stops a running buyer', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'config.json')
  const { events, sender } = capture()
  const telemetry = new BuyerTelemetry({ configPath, getDistinctId: () => WALLET, env: CONFIGURED, sender })
  assert.equal(telemetry.enabled, true)
  writeConfiguredTelemetry(configPath, false)
  telemetry.reloadConsent()
  assert.equal(telemetry.enabled, false)
  telemetry.started({ paymentsEnabled: true, verifierEnabled: false, ownsProxyPort: true })
  await telemetry.close()
  assert.equal(events.length, 0)
})

test('gateway: counts as buckets, no GeoIP, follows the config switch', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'config.json')
  await writeFile(join(dir, 'identity.key'), '22'.repeat(32))
  const { events, sender } = capture()
  const logs: string[] = []
  const gateway = new GatewayTelemetry({
    configPath, dataDir: dir, listenExposure: 'public', consoleEnabled: true, x402Enabled: true,
    counts: () => ({ workspaces: 3, keys: 40, members: 1 }), onLog: (line) => logs.push(line), env: CONFIGURED, sender,
  })
  await gateway.start()
  gateway.topup('settled', 5_000_000n)
  await gateway.stop()
  assert.match(logs.join('\n'), /antseed telemetry disable/)
  const started = events.find((event) => event.event === 'gateway_started')!
  assert.equal(started.properties['product'], 'gateway')
  assert.equal(started.properties['$geoip_disable'], true)
  assert.equal(started.properties['listen_exposure'], 'public')
  assert.equal(started.properties['workspace_count_bucket'], '2_5')
  assert.equal(started.properties['key_count_bucket'], '21_plus')
  const topup = events.find((event) => event.event === 'gateway_topup')!
  assert.equal(topup.properties['amount_bucket'], '1_10')
  assert.deepEqual(gateway.buyerEnv()['ANTSEED_TELEMETRY_HOST'], 'gateway')

  writeConfiguredTelemetry(configPath, false)
  const before = events.length
  gateway.topup('failed')
  await gateway.stop()
  assert.equal(events.length, before)
})
