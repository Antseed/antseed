import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test, { type TestContext } from 'node:test'
import type { PeerInfo } from '@antseed/node'
import type { PostHogEvent } from '@antseed/telemetry'
import { BuyerProxy } from '../proxy/buyer-proxy.js'
import { BuyerTelemetry, ConversationMemory, RequestTrace, RetryMemory, publicModelId, telemetryClientTool } from './buyer.js'
import { finishReasonFromBody } from './finish-reason.js'
import { CLIENT_TOOLS } from './catalog.js'
import { DEFAULT_APP_PROFILES } from '@antseed/connected-apps/defaults'
import { GatewayTelemetry, gatewayStepForAudit } from './gateway.js'
import { GatewayStore } from '../gateway/store.js'
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
  await writeConfiguredTelemetry(configPath, false)
  assert.equal(readConfiguredTelemetry(configPath), false)
  assert.deepEqual(resolveCliConsent(configPath, CONFIGURED), { enabled: false, reason: 'user_disabled' })
  const written = JSON.parse(await readFile(configPath, 'utf8'))
  assert.deepEqual(written, { buyer: { proxyPort: 9999 }, telemetry: { enabled: false } }, 'other keys untouched, no defaults written')
})

test('antseed telemetry writes like the other config edits: symlink kept, mode kept, invalid JSON refused', async (t) => {
  const dir = await tempDir(t)
  const target = join(dir, 'real-config.json')
  const link = join(dir, 'config.json')
  await writeFile(target, JSON.stringify({ buyer: { proxyPort: 9999 } }, null, 4))
  await chmod(target, 0o600)
  await symlink(target, link)
  await writeConfiguredTelemetry(link, false)
  assert.equal((await lstat(link)).isSymbolicLink(), true, 'the link is still a link')
  assert.equal((await stat(target)).mode & 0o777, 0o600, 'the mode is kept')
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { buyer: { proxyPort: 9999 }, telemetry: { enabled: false } })

  const broken = join(dir, 'broken.json')
  await writeFile(broken, '{ not json')
  await assert.rejects(writeConfiguredTelemetry(broken, true), /not valid JSON/)
  assert.equal(await readFile(broken, 'utf8'), '{ not json', 'an unreadable file is never overwritten')
})

test('the CLI registers antseed telemetry enable|disable|status', () => {
  const program = createProgram()
  const telemetry = program.commands.find((command) => command.name() === 'telemetry')!
  assert.deepEqual(telemetry.commands.map((command) => command.name()).sort(), ['disable', 'enable', 'status'])
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
  assert.equal(props['seller_id'], '2'.repeat(40), 'the seller of the final attempt')
  assert.equal(JSON.stringify(props).includes(SECRET_PEER), false, 'never an earlier seller, nor the error text')
  assert.equal(props['seller_choice'], 'no_conversation')
  assert.equal(props['conversation_key_source'], 'none')
  assert.equal('turn_bucket' in props, false)
  assert.equal(trace.finish(502, false, 5_000), null, 'reported once')

  assert.equal(publicModelId('my-private-finetune-xyz'), 'custom_or_unknown')
  assert.equal(telemetryClientTool('claude-code'), 'claude-code')
  assert.equal(telemetryClientTool('my-secret-tool'), 'custom')
  // Each Codex app names itself differently; all of them are Codex.
  for (const codex of ['codex-exec', 'codex_exec', 'codex-desktop', 'Codex Desktop', 'codex_vscode', 'codex-tui']) {
    assert.equal(telemetryClientTool(codex), 'codex', codex)
  }
  assert.equal(telemetryClientTool('claude-cli'), 'claude-code')
  assert.equal(telemetryClientTool('codexfoo'), 'custom', 'only the tool itself, not a name that starts the same')
  assert.equal(telemetryClientTool('claude-desktop'), 'claude-desktop')
  assert.equal(telemetryClientTool('gooeypi'), 'gooeypi')
  assert.equal(telemetryClientTool('hermes-agent'), 'hermes', 'a second slug of the same app')
  assert.equal(telemetryClientTool('cursor'), 'cursor', 'a recognized tool that is not a connected app')
  assert.equal(telemetryClientTool('  '), 'none')
})

test('every connected app is reported under its own name, never custom', () => {
  assert.ok(DEFAULT_APP_PROFILES.length > 0)
  for (const profile of DEFAULT_APP_PROFILES) {
    const name = profile['name'] as string
    const slugs = (profile['toolSlugs'] as string[] | undefined) ?? [name]
    for (const tool of [name, ...slugs]) {
      assert.equal(telemetryClientTool(tool), name, tool)
      assert.equal(CLIENT_TOOLS.has(telemetryClientTool(tool)), true, `${tool} passes the catalog`)
    }
  }
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

const OK_BODY = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }

async function proxyWithTelemetry(t: TestContext, env: NodeJS.ProcessEnv, status: number, okBody: object = OK_BODY) {
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
        return { requestId: req.requestId, statusCode: status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(status < 400 ? okBody : { error: { message: 'upstream failed' } })) }
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
  assert.equal(props['$geoip_disable'], true)
  assert.equal(props['seller_id'], SECRET_PEER, 'the public peer id of the seller that answered')
  assert.equal(props['candidates_bucket'], '1')
  assert.equal(props['chosen_rank'], '1')
  assert.equal(props['seller_choice'], 'no_conversation')
  assert.equal(typeof props['ttft_ms'], 'number', 'timings are exact; percentiles are computed in PostHog')
  assert.equal(typeof props['duration_ms'], 'number')
  assert.equal('ttft_bucket' in props, false, 'no range copies of the exact timings')
  assert.equal('duration_bucket' in props, false)
  const body = JSON.stringify(events)
  assert.equal(body.includes('my secret prompt'), false)
  assert.equal(forwarded.length, 1)
  assert.equal(Object.keys(forwarded[0]!).some((name) => name.includes('telemetry')), false)
})

test('seller choice: first turn, kept, and each kind of switch', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)
  const turn = (previous: string | null, tried: string[], status = 200, skipped: RequestTrace['previousSkipped'] = null) => {
    const trace = new RequestTrace(0, true)
    trace.conversationKey = 'claude-code:session'
    trace.conversationKeySource = 'tool_session'
    trace.turn = previous ? 4 : 1
    trace.previousSeller = previous
    trace.previousSkipped = skipped
    for (const seller of tried) trace.noteAttempt(seller)
    return trace.finish(status, false, 100)!
  }
  assert.equal(turn(null, [A])['seller_choice'], 'first_turn')
  assert.equal(turn(null, [A])['turn_bucket'], '1')
  assert.equal(turn(A, [A])['seller_choice'], 'kept_previous')
  assert.equal(turn(A, [A])['turn_bucket'], '2_5')
  assert.equal('switch_reason' in turn(A, [A]), false)
  const failedOver = turn(A, [A, B])
  assert.equal(failedOver['seller_choice'], 'switched')
  assert.equal(failedOver['switch_reason'], 'previous_failed')
  assert.equal(failedOver['seller_id'], B)
  assert.equal(turn(A, [B], 200, 'previous_cooling_down')['switch_reason'], 'previous_cooling_down')
  assert.equal(turn(A, [B])['switch_reason'], 'other')
  assert.equal(turn(A, [A], 503)['seller_choice'], 'no_answer', 'a failed turn kept or switched nothing')

  const restarted = new RequestTrace(0, true)
  restarted.conversationKey = 'k'
  restarted.turn = null
  restarted.noteAttempt(A)
  assert.equal(restarted.finish(200, false, 1)!['turn_bucket'], 'unknown', 'a conversation older than this buyer')
})

test('token counts: exact, and only as the seller reported them', () => {
  const reported = new RequestTrace(0, true)
  reported.noteUsage({ inputTokens: 40_000, cachedInputTokens: 34_000, source: 'usage' })
  const props = reported.finish(200, false, 1)!
  assert.equal(props['input_tokens'], 40_000)
  assert.equal(props['cached_input_tokens'], 34_000)
  assert.equal(props['usage_reported'], true)

  const estimated = new RequestTrace(0, true)
  estimated.noteUsage({ inputTokens: 2_000, cachedInputTokens: 0, source: 'estimated' })
  const guess = estimated.finish(200, false, 1)!
  assert.equal(guess['usage_reported'], false)
  assert.equal('input_tokens' in guess, false, 'an estimate is not sent as a count')
  assert.equal('cached_input_tokens' in guess, false, 'an estimate cannot see the cache')

  const failed = new RequestTrace(0, true)
  failed.noteUsage({ inputTokens: 5_000, cachedInputTokens: 4_000, source: 'usage' })
  assert.equal('input_tokens' in failed.finish(503, false, 1)!, false, 'counts only for a successful answer')
})

test('conversation memory: counts turns, remembers the answering seller, stays bounded', () => {
  const memory = new ConversationMemory(2)
  assert.deepEqual(memory.nextTurn('a', null), { turn: 1, previousSeller: null })
  memory.answered('a', 'seller-1')
  assert.deepEqual(memory.nextTurn('a', null), { turn: 2, previousSeller: 'seller-1' })
  assert.deepEqual(memory.nextTurn('old', 'seller-2'), { turn: null, previousSeller: 'seller-2' }, 'after a restart: seller known, turn not')
  assert.deepEqual(memory.nextTurn('old', null), { turn: null, previousSeller: 'seller-2' })
  memory.nextTurn('c', null)
  assert.deepEqual(memory.nextTurn('a', null), { turn: 1, previousSeller: null }, 'the least recent conversation was dropped')
})

test('a conversation through the proxy: turn, kept seller, cache share; nothing added for the seller', async (t) => {
  const usage = { prompt_tokens: 20_000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 19_000 } }
  const { proxy, telemetry, events, forwarded } = await proxyWithTelemetry(t, {}, 200, { ...OK_BODY, usage })
  const headers = { 'x-claude-code-session-id': '6f1c2a4e-0d55-4c1b-9a51-2f6e7d9c0b11' }
  await send(proxy, request({ model: 'gpt-5', messages: [{ role: 'user', content: 'first' }] }, headers))
  await send(proxy, request({ model: 'gpt-5', messages: [{ role: 'user', content: 'second' }] }, headers))
  await telemetry.close()
  const [first, second] = events.filter((event) => event.event === 'buyer_request_finished').map((event) => event.properties)
  assert.equal(first!['conversation_key_source'], 'tool_session')
  assert.equal(first!['turn_bucket'], '1')
  assert.equal(first!['seller_choice'], 'first_turn')
  assert.equal(second!['turn_bucket'], '2_5')
  assert.equal(second!['seller_choice'], 'kept_previous')
  assert.equal(second!['input_tokens'], 20_000)
  assert.equal(second!['cached_input_tokens'], 19_000)
  assert.equal(second!['usage_reported'], true)
  const body = JSON.stringify(events)
  assert.equal(body.includes('6f1c2a4e'), false, 'the session key never leaves the process')
  assert.equal(forwarded.every((sent) => !Object.keys(sent).some((name) => name.includes('telemetry'))), true)
})

test('a streamed answer: the cache counts in its first frame are read', async (t) => {
  const { proxy, telemetry, events } = await proxyWithTelemetry(t, {}, 200)
  const start = 'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 2_000, cache_read_input_tokens: 60_000, output_tokens: 1 } } }) + '\n\n'
  const rest = 'event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }) + '\n\n'
  ;(proxy as any)._node.sendRequestStream = async (_peer: PeerInfo, req: { requestId: string }, callbacks: {
    onResponseStart: (response: object, metadata: { streaming: boolean }) => void
    onResponseChunk: (chunk: object) => void
  }) => {
    const headers = { 'content-type': 'text/event-stream' }
    callbacks.onResponseStart({ requestId: req.requestId, statusCode: 200, headers, body: Buffer.from(start) }, { streaming: true })
    callbacks.onResponseChunk({ requestId: req.requestId, data: Buffer.from(rest), done: true })
    return { requestId: req.requestId, statusCode: 200, headers, body: Buffer.from(rest) }
  }
  const req = request({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  ;(req as unknown as Record<string, unknown>)['url'] = '/v1/messages'
  await send(proxy, req)
  await telemetry.close()
  const props = events.find((event) => event.event === 'buyer_request_finished')!.properties
  assert.equal(props['outcome'], 'success')
  assert.equal(props['input_tokens'], 62_000, 'fresh plus cached input')
  assert.equal(props['cached_input_tokens'], 60_000)
  assert.equal(props['usage_reported'], true)
})

test('a request with only a prompt cache key is grouped by it', async (t) => {
  const { proxy, telemetry, events } = await proxyWithTelemetry(t, {}, 200)
  await send(proxy, request({ model: 'gpt-5', prompt_cache_key: 'my-cache-key-123', messages: [] }, { 'user-agent': 'curl/8' }))
  await telemetry.close()
  const props = events.find((event) => event.event === 'buyer_request_finished')!.properties
  assert.equal(props['conversation_key_source'], 'prompt_cache_key')
  assert.equal(props['seller_choice'], 'first_turn')
  assert.equal(JSON.stringify(events).includes('my-cache-key-123'), false)
})

test('why the previous seller was passed over', async (t) => {
  const proxy = new BuyerProxy({ port: 0, dataDir: await tempDir(t), node: { router: { allowsPeerForPolicy: () => true, onResult: () => {} } } as never })
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)
  const verdict = (peerId: string, eligible: boolean, selection: object | undefined) =>
    ({ peer: { peerId }, serviceId: 'gpt-5', offer: {}, eligible, rank: null, reasons: [], ...(selection ? { selection } : {}) })
  const skip = (previous: string | null, verdicts: object[], ordered = [{ peerId: B }, { peerId: A }]) =>
    (proxy as any)._previousSellerSkipped(previous, ordered, verdicts)
  assert.equal(skip(null, []), null)
  assert.equal(skip(A, [verdict(B, true, {})]), 'previous_unavailable')
  assert.equal(skip(A, [verdict(A, false, undefined), verdict(B, true, {})]), 'previous_excluded')
  assert.equal(skip(A, [verdict(A, true, { coolingDown: true }), verdict(B, true, {})]), 'previous_cooling_down')
  assert.equal(skip(A, [verdict(A, true, { failing: true }), verdict(B, true, {})]), 'previous_unhealthy')
  assert.equal(skip(A, [verdict(A, true, {}), verdict(B, true, { routeChainPosition: 1 })]), 'policy_route')
  assert.equal(skip(A, [verdict(A, true, {}), verdict(B, true, {})]), 'other')
  assert.equal(skip(A, [verdict(A, true, {})], [{ peerId: A }]), null, 'it is first: nothing was skipped')
})

test('a gateway buyer sends the same per-request event, tagged gateway', async (t) => {
  const { proxy, telemetry, events } = await proxyWithTelemetry(t, { ANTSEED_TELEMETRY_HOST: 'gateway' }, 503)
  await send(proxy, request({ model: 'gpt-5', messages: [] }))
  await send(proxy, request({ model: 'gpt-5', messages: [] }))
  await telemetry.close()
  const finished = events.filter((event) => event.event === 'buyer_request_finished')
  assert.equal(finished.length, 2, 'one event per request, as on the desktop')
  for (const event of finished) {
    assert.equal(event.properties['outcome'], 'failed')
    assert.equal(event.properties['failure_reason'], 'seller_5xx')
    assert.equal(event.properties['buyer_host'], 'gateway')
    assert.equal(event.properties['$geoip_disable'], true)
  }
})

test('turning telemetry off in the config stops a running buyer', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'config.json')
  const { events, sender } = capture()
  const telemetry = new BuyerTelemetry({ configPath, getDistinctId: () => WALLET, env: CONFIGURED, sender })
  assert.equal(telemetry.enabled, true)
  await writeConfiguredTelemetry(configPath, false)
  telemetry.reloadConsent()
  assert.equal(telemetry.enabled, false)
  telemetry.started({ paymentsEnabled: true, verifierEnabled: false, ownsProxyPort: true })
  await telemetry.close()
  assert.equal(events.length, 0)
})

test('speed and cost: exact times, output tokens, finish reason and listed-price cost', () => {
  const trace = new RequestTrace(1_000, true)
  trace.noteAttempt(SECRET_PEER)
  trace.noteFirstByte(1_850)
  trace.noteUsage({ inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 640, source: 'usage' })
  trace.noteAnswerDetails({ finishReason: 'length', estimatedCostUsd: 0.004321 })
  const props = trace.finish(200, false, 9_400)!
  assert.equal(props['ttft_ms'], 850)
  assert.equal(props['duration_ms'], 8_400)
  assert.equal(props['output_tokens'], 640)
  assert.equal(props['finish_reason'], 'length')
  assert.equal(props['estimated_cost_micro_usd'], 4_321)
  assert.equal(props['client_retry'], false)

  const failed = new RequestTrace(0, true)
  failed.noteAttempt(SECRET_PEER)
  failed.noteUsage({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, source: 'usage' })
  failed.noteAnswerDetails({ finishReason: 'stop', estimatedCostUsd: 0.01 })
  const failedProps = failed.finish(503, false, 2_000)!
  assert.equal('ttft_ms' in failedProps, false, 'no first byte, no ttft')
  assert.equal(failedProps['duration_ms'], 2_000)
  for (const key of ['output_tokens', 'finish_reason', 'estimated_cost_micro_usd']) {
    assert.equal(key in failedProps, false, `${key} only for a successful answer`)
  }

  const retried = new RequestTrace(0, true)
  retried.noteAttempt(SECRET_PEER)
  retried.noteUsage({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, source: 'usage' })
  retried.noteAnswerDetails({ finishReason: 'stop', estimatedCostUsd: 0.01 })
  retried.noteAttempt('2'.repeat(40))
  const retriedProps = retried.finish(200, false, 100)!
  assert.equal('output_tokens' in retriedProps, false, 'a later attempt does not inherit an earlier one')
  assert.equal('finish_reason' in retriedProps, false)

  // Seller A's error reply came first, then seller B answered: B's answer is the first byte.
  const fellBack = new RequestTrace(0, true)
  fellBack.noteAttempt(SECRET_PEER, 0)
  fellBack.noteAnswered(300, 503)
  fellBack.noteFailure({ statusCode: 503, responseBody: Buffer.from('overloaded'), errorMessage: null })
  fellBack.noteAttempt('2'.repeat(40), 320)
  fellBack.noteFirstByte(1_300)
  const fellBackProps = fellBack.finish(200, false, 2_000)!
  assert.equal(fellBackProps['ttft_ms'], 1_300, 'what the caller waited, not the failed seller\'s error reply')
  assert.equal(fellBackProps['seller_ttft_ms'], 980, 'the answering seller\'s own time')
  assert.equal(fellBackProps['failed_attempts_ms'], 320, 'time lost on seller A')
  assert.equal(fellBackProps['rate_limited'], false)
  assert.equal(fellBackProps['routing_version'], 'v1')

  // A 429 (seller busy) is counted; a used-up free allowance (also 429) is not.
  const busy = new RequestTrace(0, true)
  busy.noteAttempt(SECRET_PEER, 0)
  busy.noteAnswered(100, 429)
  busy.noteAttempt(SECRET_PEER, 400)
  busy.noteAnswered(900, 200)
  const busyProps = busy.finish(200, false, 900)!
  assert.equal(busyProps['rate_limited'], true)
  assert.equal(busyProps['failed_attempts_ms'], 400, 'the 429 and the wait before retrying')
  assert.equal(busyProps['seller_ttft_ms'], 500)
  const freeLimit = new RequestTrace(0, true)
  freeLimit.noteAttempt(SECRET_PEER, 0)
  freeLimit.noteAnswered(100, 429, true)
  assert.equal(freeLimit.finish(429, false, 100)!['rate_limited'], false, 'a free-tier limit is not a busy seller')

  // A request that failed on every seller lost all of its time to failed attempts.
  const allFailed = new RequestTrace(0, true)
  allFailed.noteAttempt(SECRET_PEER, 0)
  allFailed.noteAnswered(200, 503)
  allFailed.noteAttempt('2'.repeat(40), 250)
  allFailed.noteAnswered(600, 503)
  const allFailedProps = allFailed.finish(503, false, 600)!
  assert.equal(allFailedProps['failed_attempts_ms'], 600)
  assert.equal('ttft_ms' in allFailedProps, false, 'an error reply is not output')
  assert.equal('seller_ttft_ms' in allFailedProps, false)

  const unpriced = new RequestTrace(0, true)
  unpriced.noteAttempt(SECRET_PEER)
  unpriced.noteUsage({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, source: 'usage' })
  unpriced.noteAnswerDetails({ finishReason: 'stop', estimatedCostUsd: null })
  assert.equal('estimated_cost_micro_usd' in unpriced.finish(200, false, 1)!, false, 'no price, no cost')
})

test('finish reason: read from each protocol, streamed or whole', () => {
  const json = (body: object) => Buffer.from(JSON.stringify(body))
  const sse = (...events: object[]) => Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n')
  assert.equal(finishReasonFromBody('application/json', json({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] })), 'stop')
  assert.equal(finishReasonFromBody('application/json', json({ choices: [{ message: {}, finish_reason: 'tool_calls' }] })), 'tool_call')
  assert.equal(finishReasonFromBody('text/event-stream', sse({ choices: [{ delta: { content: 'x' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] })), 'length')
  assert.equal(finishReasonFromBody('application/json', json({ type: 'message', content: [], stop_reason: 'end_turn' })), 'stop')
  assert.equal(finishReasonFromBody('text/event-stream', sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } })), 'length')
  assert.equal(finishReasonFromBody('text/event-stream', sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } })), 'tool_call')
  assert.equal(finishReasonFromBody('application/json', json({ object: 'response', status: 'completed', output: [{ type: 'function_call' }] })), 'tool_call')
  assert.equal(finishReasonFromBody('application/json', json({ object: 'response', status: 'incomplete', incomplete_details: { reason: 'content_filter' } })), 'content_filter')
  assert.equal(finishReasonFromBody('text/event-stream', sse({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message' }] } })), 'stop')
  assert.equal(finishReasonFromBody('application/json', json({ choices: [{ finish_reason: 'something_new' }] })), 'other')
  assert.equal(finishReasonFromBody('application/json', Buffer.from('not json')), 'unknown')
  assert.equal(finishReasonFromBody('application/json', json({ data: [] })), 'unknown')
})

test('retry memory: a repeat of a request that did not succeed is a retry; a repeat after success is not', () => {
  const memory = new RetryMemory(60_000)
  assert.equal(memory.seen('a', 0), false, 'first copy')
  memory.finished('a', false, 1_000)
  assert.equal(memory.seen('a', 2_000), true, 'sent again after it failed')
  memory.finished('a', true, 3_000)
  assert.equal(memory.seen('a', 4_000), false, 'sent again after it succeeded: a new request')
  memory.finished('a', false, 5_000)
  assert.equal(memory.seen('a', 70_000), false, 'too long after: a new request')
  assert.equal(memory.seen('b', 70_001), false)
})

test('client retry: the same request after a failure is marked, keeps its turn, and nothing reaches the seller', async (t) => {
  const { proxy, telemetry, events, forwarded } = await proxyWithTelemetry(t, {}, 503)
  const body = { model: 'gpt-5', prompt_cache_key: 'conv-1', messages: [{ role: 'user', content: 'hi' }] }
  await send(proxy, request(body, { 'user-agent': 'curl/8' }))
  await send(proxy, request(body, { 'user-agent': 'curl/8' }))
  // Codex resends a turn with the same content but its keys in another order.
  const reordered = { messages: body.messages, prompt_cache_key: body.prompt_cache_key, model: body.model }
  await send(proxy, request(reordered, { 'user-agent': 'curl/8' }))
  await send(proxy, request({ ...body, messages: [{ role: 'user', content: 'something else' }] }, { 'user-agent': 'curl/8' }))
  await telemetry.close()
  const finished = events.filter((event) => event.event === 'buyer_request_finished').map((event) => event.properties)
  assert.deepEqual(finished.map((props) => props['client_retry']), [false, true, true, false])
  assert.deepEqual(finished.map((props) => props['turn_bucket']), ['1', '1', '1', '2_5'], 'a retry is the same turn')
  assert.equal(Object.keys(forwarded[0]!).some((name) => name.includes('telemetry') || name.includes('retry')), false)
  assert.equal(JSON.stringify(events).includes('conv-1'), false)
})

test('a proxied answer carries its speed, output tokens, finish reason and cost', async (t) => {
  const okBody = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1_000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 600 } } }
  const { proxy, telemetry, events } = await proxyWithTelemetry(t, {}, 200, okBody)
  await send(proxy, request({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }))
  await telemetry.close()
  const props = events.find((event) => event.event === 'buyer_request_finished')!.properties
  assert.equal(props['output_tokens'], 500)
  assert.equal(props['finish_reason'], 'stop')
  assert.equal(typeof props['duration_ms'], 'number')
  assert.equal(typeof props['ttft_ms'], 'number')
  // 400 fresh input at $1/M (no cached rate: billed as input) + 600 cached at $1/M + 500 output at $2/M.
  assert.equal(props['estimated_cost_micro_usd'], 2_000)
})

test('after a fallback, time to first byte is the answering seller\'s, not the failed seller\'s error', async (t) => {
  const dir = await tempDir(t)
  const { events, sender } = capture()
  const telemetry = new BuyerTelemetry({ configPath: join(dir, 'config.json'), getDistinctId: () => WALLET, env: CONFIGURED, sender })
  const failing = { ...makePeer(), peerId: '1'.repeat(40) } as PeerInfo
  const answering = { ...makePeer(), peerId: '2'.repeat(40) } as PeerInfo
  const proxy = new BuyerProxy({
    adaptiveRouting: { spreadTolerance: 0, explorationRate: 0 },
    port: 0,
    dataDir: dir,
    telemetry,
    node: {
      router: { allowsPeerForPolicy: () => true, onResult: () => {} },
      sendRequest: async (peer: PeerInfo, req: { requestId: string }) => {
        const fails = peer.peerId === failing.peerId
        await new Promise((resolve) => setTimeout(resolve, fails ? 20 : 200))
        return fails
          ? { requestId: req.requestId, statusCode: 503, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: { message: 'overloaded' } })) }
          : { requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(OK_BODY)) }
      },
    } as never,
  })
  ;(proxy as any)._getPeers = async () => [failing, answering]
  ;(proxy as any)._cachedPeers = [failing, answering]
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  const res = await send(proxy, request({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(res.statusCode, 200)
  await telemetry.close()
  const props = events.find((event) => event.event === 'buyer_request_finished')!.properties
  assert.equal(props['seller_id'], answering.peerId)
  assert.equal(props['fell_back'], true)
  assert.ok((props['ttft_ms'] as number) >= 200, `ttft_ms ${props['ttft_ms']} includes the answering seller's time`)
  assert.ok((props['seller_ttft_ms'] as number) >= 200 && (props['seller_ttft_ms'] as number) <= (props['ttft_ms'] as number))
  assert.ok((props['failed_attempts_ms'] as number) >= 20, 'the failed seller\'s time is counted')
  assert.equal(props['routing_version'], 'v1')
})

test('the client stopping a streamed answer midway is cancelled, not success, and sends no token counts', async (t) => {
  const { proxy, telemetry, events } = await proxyWithTelemetry(t, {}, 200)
  const res = new FakeResponse()
  const start = 'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 2_000, output_tokens: 1 } } }) + '\n\n'
  ;(proxy as any)._node.sendRequestStream = async (_peer: PeerInfo, req: { requestId: string }, callbacks: {
    onResponseStart: (response: object, metadata: { streaming: boolean }) => void
  }, options: { signal: AbortSignal }) => {
    callbacks.onResponseStart({ requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: Buffer.from(start) }, { streaming: true })
    // The user presses stop: the client hangs up while the answer streams.
    queueMicrotask(() => res.emit('close'))
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
    throw new Error('aborted')
  }
  const req = request({ model: 'gpt-5', stream: true, messages: [{ role: 'user', content: 'hi' }] })
  ;(req as unknown as Record<string, unknown>)['url'] = '/v1/messages'
  await (proxy as any)._handleRequest(req, res)
  await new Promise((resolve) => setImmediate(resolve))
  await telemetry.close()
  const finished = events.filter((event) => event.event === 'buyer_request_finished')
  assert.equal(finished.length, 1, 'reported once')
  const props = finished[0]!.properties
  assert.equal(props['outcome'], 'cancelled')
  assert.equal(props['failure_reason'], 'none', 'a stop is not a failure')
  assert.equal(typeof props['ttft_ms'], 'number', 'the first byte had arrived')
  assert.equal('input_tokens' in props, false, 'a stopped answer sends no token counts')
})

test('a rate-limited seller retried in place: rate_limited, and the wait counts as lost time', async (t) => {
  const dir = await tempDir(t)
  const { events, sender } = capture()
  const telemetry = new BuyerTelemetry({ configPath: join(dir, 'config.json'), getDistinctId: () => WALLET, env: CONFIGURED, sender })
  const peer = makePeer()
  let calls = 0
  const proxy = new BuyerProxy({
    adaptiveRouting: { spreadTolerance: 0, explorationRate: 0 },
    port: 0,
    dataDir: dir,
    telemetry,
    node: {
      router: { allowsPeerForPolicy: () => true, onResult: () => {} },
      sendRequest: async (_peer: PeerInfo, req: { requestId: string }) => {
        calls += 1
        return calls === 1
          ? { requestId: req.requestId, statusCode: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' }, body: Buffer.from(JSON.stringify({ error: { message: 'slow down' } })) }
          : { requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(OK_BODY)) }
      },
    } as never,
  })
  ;(proxy as any)._getPeers = async () => [peer]
  ;(proxy as any)._cachedPeers = [peer]
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  const res = await send(proxy, request({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(res.statusCode, 200)
  assert.equal(calls, 2)
  await telemetry.close()
  const props = events.find((event) => event.event === 'buyer_request_finished')!.properties
  assert.equal(props['outcome'], 'success')
  assert.equal(props['rate_limited'], true)
  assert.equal(props['attempt_count'], '2')
  assert.equal(props['fell_back'], false, 'the same seller')
})

test('image, decision-model and video requests each send buyer_request_finished', async (t) => {
  const dir = await tempDir(t)
  const { events, sender } = capture()
  const telemetry = new BuyerTelemetry({ configPath: join(dir, 'config.json'), getDistinctId: () => WALLET, env: CONFIGURED, sender })
  const peer = {
    ...makePeer(),
    providers: ['openai', 'typesafe', 'venice'],
    providerPricing: {
      openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'gpt-image-1': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } },
      typesafe: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'decide-1': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } },
      venice: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'video-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } },
    },
    providerServiceApiProtocols: {
      openai: { services: { 'gpt-image-1': ['openai-images'] } },
      typesafe: { services: { 'decide-1': ['typesafe-systemone'] } },
      venice: { services: { 'video-model': ['venice-video'] } },
    },
    // An image edit is only routed to a seller that takes an input image.
    providerServiceCapabilities: { openai: { services: { 'gpt-image-1': { outputs: ['image'], supportedParameters: ['image'] } } } },
  } as unknown as PeerInfo
  const forwarded: string[] = []
  const proxy = new BuyerProxy({
    adaptiveRouting: { spreadTolerance: 0, explorationRate: 0 },
    port: 0,
    dataDir: dir,
    telemetry,
    node: {
      router: { allowsPeerForPolicy: () => true, onResult: () => {} },
      sendRequest: async (_peer: PeerInfo, req: { requestId: string; path: string; headers: Record<string, string> }) => {
        forwarded.push(Object.keys(req.headers).join(','))
        const body = req.path.includes('/video/') ? { queue_id: 'job-1' } : req.path.includes('systemone') ? { answers: [] } : { data: [{ b64_json: 'aGk=' }] }
        return { requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) }
      },
      sendRequestStream: async (_peer: PeerInfo, req: { requestId: string }) => (
        { requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ status: 'PROCESSING' })) }
      ),
    } as never,
  })
  ;(proxy as any)._getPeers = async () => [peer]
  ;(proxy as any)._cachedPeers = [peer]
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  ;(proxy as any)._persistResourceRoutes = async () => {}
  const at = (path: string, body: object): Readable => {
    const req = request(body, { 'user-agent': 'curl/8' }) as Readable & Record<string, unknown>
    req['url'] = path
    return req
  }
  const calls: Array<[string, object]> = [
    ['/v1/images/generations', { model: 'gpt-image-1', prompt: 'a secret cat' }],
    ['/v1/images/edits', { model: 'gpt-image-1', prompt: 'a secret hat', image: 'aGk=' }],
    ['/v1/systemone', { model: 'decide-1', state: { secret: true }, questions: [] }],
    ['/api/v1/video/queue', { model: 'video-model', prompt: 'a secret dog', duration: '5s' }],
    ['/api/v1/video/retrieve', { model: 'video-model', queue_id: 'job-1' }],
  ]
  for (const [path, body] of calls) {
    const res = await send(proxy, at(path, body))
    assert.equal(res.statusCode, 200, `${path}: ${res.body}`)
  }
  await telemetry.close()
  const finished = events.filter((event) => event.event === 'buyer_request_finished').map((event) => event.properties)
  assert.deepEqual(finished.map((props) => props['protocol']), ['openai-images', 'openai-images', 'typesafe-systemone', 'video', 'video'])
  assert.deepEqual(finished.map((props) => props['video_action'] ?? null), [null, null, null, 'create', 'retrieve'])
  assert.deepEqual(finished.map((props) => props['outcome']), ['success', 'success', 'success', 'success', 'success'])
  for (const props of finished.slice(0, 3)) assert.equal(props['seller_id'], SECRET_PEER)
  assert.equal(JSON.stringify(events).includes('secret'), false, 'no prompt or state leaves the process')
  assert.equal(forwarded.some((names) => names.includes('telemetry')), false, 'nothing added for the seller')
})

test('buyer_deposit_credited: one per deposit, as a bucket, the tx-hash backfill skipped', async () => {
  const { events, sender } = capture()
  const telemetry = new BuyerTelemetry({ configPath: null, getDistinctId: () => WALLET, env: CONFIGURED, sender, forceEnabled: true })
  telemetry.depositCredited(WALLET, { amountBaseUnits: '4900000' })
  telemetry.depositCredited(WALLET, { amountBaseUnits: '4900000', txHash: '0xabc' })
  telemetry.depositCredited(WALLET, { amountBaseUnits: '25000000', txHash: '0xdef' })
  telemetry.depositCredited(WALLET, { amountBaseUnits: 'not-a-number' })
  await telemetry.close()
  assert.deepEqual(events.map((event) => event.properties['amount_bucket']), ['1_10', 'over_10'])
  assert.equal(JSON.stringify(events).includes('0xabc'), false)
  assert.equal(JSON.stringify(events).includes('4900000'), false)
})

test('gateway funnel: audit actions map to steps; everything else is ignored', () => {
  assert.equal(gatewayStepForAudit('auth.setup_claim'), 'console_claimed')
  assert.equal(gatewayStepForAudit('workspace.create'), 'workspace_created')
  assert.equal(gatewayStepForAudit('key.create'), 'key_created')
  assert.equal(gatewayStepForAudit('invite.create'), 'member_invited')
  assert.equal(gatewayStepForAudit('auth.invite_accept'), 'invite_accepted')
  assert.equal(gatewayStepForAudit('auth.sign_in'), 'signed_in')
  for (const action of ['auth.sign_in_failed', 'key.revoke', 'workspace.update', 'settings.telemetry.update', '']) {
    assert.equal(gatewayStepForAudit(action), null)
  }
})

test('gateway_step: sent from the audit log with only the step, under the gateway wallet', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'identity.key'), '11'.repeat(32))
  const store = new GatewayStore(dir)
  t.after(() => store.close())
  const { events, sender } = capture()
  const logs: string[] = []
  const telemetry = new GatewayTelemetry({
    configPath: join(dir, 'config.json'), dataDir: dir, env: CONFIGURED, sender, onLog: (message) => { logs.push(message) },
  })
  store.setAuditObserver((record) => telemetry.observeAudit(record))
  await telemetry.start()
  const actor = { kind: 'member' as const, id: 'mem_secret', label: 'Dana Secret' }
  store.recordAudit({ actor, action: 'workspace.create', target: { kind: 'workspace', id: 'ws_secret', label: 'Secret Team' }, details: { name: 'Secret Team' }, ip: '203.0.113.9' })
  store.recordAudit({ actor, action: 'key.revoke', details: {} })
  store.recordAudit({ actor, action: 'auth.sign_in', details: { method: 'passkey' }, ip: '203.0.113.9' })
  await telemetry.stop()

  assert.deepEqual(events.map((event) => event.properties['step']), ['gateway_started', 'workspace_created', 'signed_in'])
  const wallet = events[0]!.distinct_id
  assert.match(wallet, /^0x[0-9a-f]{40}$/)
  for (const event of events) {
    assert.equal(event.event, 'gateway_step')
    assert.equal(event.distinct_id, wallet)
    assert.equal(event.properties['product'], 'gateway')
    assert.equal(event.properties['$geoip_disable'], true)
  }
  const sent = JSON.stringify(events)
  for (const secret of ['Secret', 'mem_secret', 'ws_secret', '203.0.113.9', 'passkey']) assert.equal(sent.includes(secret), false, secret)
  assert.equal(logs.filter((line) => line.includes('antseed telemetry disable')).length, 1)
  assert.equal(store.listAudit().entries.length, 3, 'the audit log itself is unchanged')
})

test('gateway_step: consent is read live, and a failing observer never breaks the audit write', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'identity.key'), '11'.repeat(32))
  const configPath = join(dir, 'config.json')
  const store = new GatewayStore(dir)
  t.after(() => store.close())
  const { events, sender } = capture()
  const telemetry = new GatewayTelemetry({ configPath, dataDir: dir, env: CONFIGURED, sender })
  await telemetry.start()
  await writeConfiguredTelemetry(configPath, false)
  telemetry.observeAudit({ action: 'key.create' })
  await telemetry.stop()
  // The queue re-checks consent before it sends: after an opt-out nothing leaves, queued steps included.
  assert.deepEqual(events, [])

  store.setAuditObserver(() => { throw new Error('boom') })
  const record = store.recordAudit({ actor: { kind: 'cli', id: null }, action: 'key.create' })
  assert.equal(record.action, 'key.create')
  assert.equal(store.listAudit().entries.length, 1)
})
