/**
 * The buyer answers every request on one thread, so anything slow in it stops
 * all of them: streams stall, and a gateway in front of it sees its spend feed
 * and its policy check time out. These tests hold the paths that once did that
 * to a network and a history of realistic size. The time limits are many times
 * what the code needs and a small fraction of what the regressions took; the
 * counts are exact.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import type { PeerInfo } from '@antseed/node'
import { BuyerProxy, mergeJsonStateFile, readJsonStateFileKeys } from './buyer-proxy.js'

const SELLERS = 100
const MODELS = 750
const MODELS_PER_SELLER = 120
/** What one read of a buyer's channels costs on a long-lived buyer's database. */
const CHANNEL_READ_MS = 5

const modelId = (index: number): string => `model-${index}`

/** `SELLERS` sellers, each offering `MODELS_PER_SELLER` of `MODELS` chat models through two providers. */
function makeNetwork(): PeerInfo[] {
  return Array.from({ length: SELLERS }, (_, seller) => {
    const services = (offset: number) => Object.fromEntries(Array.from({ length: MODELS_PER_SELLER / 2 }, (_unused, slot) => {
      const id = modelId((seller * 37 + offset + slot * 7) % MODELS)
      return [id, { inputUsdPerMillion: 1 + (seller % 5), outputUsdPerMillion: 2 + (seller % 7) }]
    }))
    const first = services(0)
    const second = services(3)
    const protocols = (priced: Record<string, unknown>, protocol: string) => Object.fromEntries(Object.keys(priced).map((id) => [id, [protocol]]))
    return {
      peerId: seller.toString(16).padStart(40, '0') as PeerInfo['peerId'],
      lastSeen: Date.now(),
      providers: ['alpha', 'beta'],
      reputationScore: 80,
      capabilities: ['verifier.antseed-verifier', 'free-tier.v1.r10', 'free-tier.v1.w86400'],
      providerPricing: {
        alpha: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: first },
        beta: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: second },
      },
      providerServiceApiProtocols: {
        alpha: { services: protocols(first, 'openai-chat-completions') },
        beta: { services: protocols(second, 'anthropic-messages') },
      },
    } as PeerInfo
  })
}

function makeProxy(peers: PeerInfo[], dataDir = '/tmp/antseed-test'): { proxy: BuyerProxy; channelReads: () => number } {
  let reads = 0
  const proxy = new BuyerProxy({
    port: 0,
    dataDir,
    node: {
      router: { allowsPeerForPolicy: () => true, onResult: () => {} },
      getActiveBuyerChannels: () => {
        reads += 1
        const until = performance.now() + CHANNEL_READ_MS
        while (performance.now() < until) { /* a database read holds the thread */ }
        return [{ peerId: peers[1]!.peerId }]
      },
    } as any,
    routingPreferences: { preferFreePeers: false, maxInputUsdPerMillion: 25, minTrustScore: 0, allowedPeerIds: [], blockedPeerIds: [] },
  })
  ;(proxy as any)._getPeers = async () => peers
  ;(proxy as any)._cacheLastUpdatedAtMs = Date.now()
  return { proxy, channelReads: () => reads }
}

function makeResponse() {
  return {
    statusCode: 0,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(statusCode: number) { this.statusCode = statusCode; this.headersSent = true; return this },
    setHeader() { return this },
    getHeader() { return undefined },
    write(chunk: string | Uint8Array) { this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(); return true },
    end(chunk?: string | Uint8Array) { if (chunk) this.write(chunk); this.writableEnded = true; return this },
    on() { return this },
    once() { return this },
  }
}

async function get(proxy: BuyerProxy, path: string): Promise<{ statusCode: number; body: string }> {
  const req = Object.assign(Readable.from([]), { method: 'GET', url: path, headers: {}, complete: true })
  const res = makeResponse()
  await (proxy as any)._handleRequest(req, res)
  return res
}

/** Runs `work` and reports how long it took and the longest the thread went without yielding. */
async function measure<T>(work: () => Promise<T>): Promise<{ result: T; elapsedMs: number; longestStallMs: number }> {
  let last = performance.now()
  let longestStallMs = 0
  const tick = setInterval(() => {
    const now = performance.now()
    longestStallMs = Math.max(longestStallMs, now - last)
    last = now
  }, 1)
  const started = performance.now()
  try {
    const result = await work()
    // One more turn, so a stall that ends the work is counted.
    await new Promise((resolve) => setTimeout(resolve, 2))
    return { result, elapsedMs: performance.now() - started, longestStallMs }
  } finally {
    clearInterval(tick)
  }
}

test('a model list over a large network reads the open channels once and never holds the buyer for long', async () => {
  const { proxy, channelReads } = makeProxy(makeNetwork())

  const { result, elapsedMs, longestStallMs } = await measure(() => get(proxy, '/v1/models'))

  assert.equal(result.statusCode, 200)
  assert.equal((JSON.parse(result.body).data as unknown[]).length, MODELS)
  assert.equal(channelReads(), 1, 'one read for the whole list, not one per model and protocol')
  // Read per model, the channel reads alone take MODELS × CHANNEL_READ_MS = 3.75 s.
  assert.ok(elapsedMs < 1_500, `the list took ${elapsedMs.toFixed(0)} ms`)
  assert.ok(longestStallMs < 1_500, `the buyer was held for ${longestStallMs.toFixed(0)} ms`)
})

test('looking up one model costs no more than the list', async () => {
  const { proxy, channelReads } = makeProxy(makeNetwork())

  const { result, elapsedMs } = await measure(() => get(proxy, `/v1/models/${modelId(5)}`))

  assert.equal(result.statusCode, 200)
  assert.equal(JSON.parse(result.body).id, modelId(5))
  assert.equal(channelReads(), 1)
  assert.ok(elapsedMs < 1_500, `the lookup took ${elapsedMs.toFixed(0)} ms`)
})

test('repeated model lists stay fast: nothing builds up between them', async () => {
  const { proxy, channelReads } = makeProxy(makeNetwork())
  await get(proxy, '/v1/models')

  const { elapsedMs, longestStallMs } = await measure(async () => {
    for (let i = 0; i < 10; i += 1) {
      await get(proxy, '/v1/models')
      // Requests arrive on separate turns of the event loop, as from a socket.
      await new Promise((resolve) => setImmediate(resolve))
    }
  })

  assert.equal(channelReads(), 11)
  assert.ok(elapsedMs < 5_000, `ten lists took ${elapsedMs.toFixed(0)} ms`)
  assert.ok(longestStallMs < 1_500, `the buyer was held for ${longestStallMs.toFixed(0)} ms`)
})

test('routing chat requests over a large network reads the open channels once per request and stays fast', async () => {
  const peers = makeNetwork()
  const { proxy, channelReads } = makeProxy(peers)
  ;(proxy as any)._node.sendRequest = async (_peer: PeerInfo, request: { requestId: string }) => ({
    requestId: request.requestId,
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })),
  })
  const chat = (index: number) => {
    const body = Buffer.from(JSON.stringify({ model: modelId(index), messages: [{ role: 'user', content: 'hi' }] }))
    const req = Object.assign(Readable.from([body]), { method: 'POST', url: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, complete: true })
    return (proxy as any)._handleRequest(req, makeResponse()).then(() => undefined)
  }
  await chat(0)
  const readsPerRequest = channelReads()

  const { elapsedMs, longestStallMs } = await measure(async () => {
    for (let i = 1; i <= 40; i += 1) {
      await chat(i)
      await new Promise((resolve) => setImmediate(resolve))
    }
  })

  assert.equal(readsPerRequest, 1)
  assert.equal(channelReads(), 41)
  assert.ok(elapsedMs < 4_000, `forty requests took ${elapsedMs.toFixed(0)} ms`)
  assert.ok(longestStallMs < 500, `one request held the buyer for ${longestStallMs.toFixed(0)} ms`)
})

/** A state file the size a busy gateway's buyer reaches: megabytes of peer cache and video routes. */
async function writeLargeState(stateFile: string): Promise<void> {
  const routes = Array.from({ length: 20_000 }, (_, index) => ({
    protocol: 'example-video', resourceId: `job-${index}`, sellerPeerId: 'a'.repeat(40), provider: 'example-video', service: 'example/text-to-video', createdAt: index,
  }))
  const peers = Array.from({ length: 100 }, (_, index) => ({ peerId: index.toString(16).padStart(40, '0'), notes: 'x'.repeat(20_000) }))
  await writeFile(stateFile, JSON.stringify({ pinnedPeerId: null, resourceRoutes: routes, discoveredPeers: peers }))
}

test('a small change to a large state file does not read the file back or rewrite its other values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-speed-'))
  try {
    const stateFile = join(dir, 'buyer.state.json')
    await writeLargeState(stateFile)
    const original = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>
    // The first change reads the file; the rest reuse what this process wrote.
    await mergeJsonStateFile(dir, stateFile, { peerHealthUpdatedAt: 0 })

    // Parsing and re-serializing the whole file held the buyer for a tenth of a second per change.
    const megabyte = 1_000_000
    const large = { parsed: 0, serialized: 0 }
    const { parse, stringify } = JSON
    JSON.parse = ((text: string, ...rest: []) => {
      if (text.length > megabyte) large.parsed += 1
      return parse(text, ...rest)
    }) as typeof JSON.parse
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      const text = stringify(...args)
      if (text !== undefined && text.length > megabyte) large.serialized += 1
      return text
    }) as typeof JSON.stringify
    let longestStallMs: number
    try {
      ({ longestStallMs } = await measure(async () => {
        for (let i = 1; i <= 40; i += 1) await mergeJsonStateFile(dir, stateFile, { peerHealthUpdatedAt: i })
      }))
    } finally {
      JSON.parse = parse
      JSON.stringify = stringify
    }

    assert.deepEqual(large, { parsed: 0, serialized: 0 }, 'the megabytes already on disk are neither parsed nor serialized again')
    assert.ok(longestStallMs < 250, `a change held the buyer for ${longestStallMs.toFixed(0)} ms`)
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, unknown>
    assert.deepEqual(state, { ...original, peerHealthUpdatedAt: 40 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a state file another process changed is read again, and its changes are kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-speed-'))
  try {
    const stateFile = join(dir, 'buyer.state.json')
    await mergeJsonStateFile(dir, stateFile, { pinnedPeerId: null, kept: [1, 2] })
    assert.deepEqual(await readJsonStateFileKeys(stateFile, ['pinnedPeerId']), { pinnedPeerId: null })

    // `antseed buyer connection set` writes the pin from another process.
    await writeFile(stateFile, JSON.stringify({ pinnedPeerId: 'b'.repeat(40), kept: [1, 2], added: true }))
    assert.deepEqual(await readJsonStateFileKeys(stateFile, ['pinnedPeerId', 'missing']), { pinnedPeerId: 'b'.repeat(40) })

    await writeFile(stateFile, JSON.stringify({ pinnedPeerId: 'c'.repeat(40), kept: [1, 2], added: true }))
    await mergeJsonStateFile(dir, stateFile, { peerHealthUpdatedAt: 7, added: undefined })
    assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { pinnedPeerId: 'c'.repeat(40), kept: [1, 2], peerHealthUpdatedAt: 7 })

    await writeFile(stateFile, '{ not json')
    assert.equal(await readJsonStateFileKeys(stateFile, ['pinnedPeerId']), null, 'an unreadable file changes nothing')
    await rm(stateFile)
    assert.equal(await readJsonStateFileKeys(stateFile, ['pinnedPeerId']), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('answered requests do not write the state file one by one; stopping saves what they changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-buyer-speed-'))
  try {
    const peers = makeNetwork().slice(0, 3)
    const { proxy } = makeProxy(peers, dir)
    ;(proxy as any)._cachedPeers = peers
    const stateFile = join(dir, 'buyer.state.json')
    await mergeJsonStateFile(dir, stateFile, { state: 'connected' })
    const before = await stat(stateFile)

    for (let i = 0; i < 500; i += 1) (proxy as any)._rememberSuccessfulPeer(peers[i % 3]!.peerId)
    await (proxy as any)._stateWriteChain
    await new Promise((resolve) => setTimeout(resolve, 50))

    const after = await stat(stateFile)
    assert.deepEqual([after.ino, after.mtimeMs, after.size], [before.ino, before.mtimeMs, before.size], 'no write per answered request')

    await proxy.stop()
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as { discoveredPeers: Array<{ peerId: string; lastReachedAt: number | null }>; peerHealthUpdatedAt: number }
    assert.equal(typeof state.peerHealthUpdatedAt, 'number')
    assert.deepEqual(state.discoveredPeers.map((peer) => typeof peer.lastReachedAt), ['number', 'number', 'number'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
