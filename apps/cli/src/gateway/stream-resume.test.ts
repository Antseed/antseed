import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as http from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { GatewayAccounting } from './accounting.js'
import { tempDataDir } from './console-api/test-support.js'
import { GatewayServer } from './server.js'
import { SpendFeedPoller } from './spend-feed.js'
import type { GatewayStore } from './store.js'
import { StreamResumeStore, type StreamResumeOptions, type StreamSource } from './stream-resume.js'

const NO_LIMITS = { daily: null, monthly: null, total: null }
const CHUNKS = 40

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The stream files under a resume folder, whatever process folder holds them. */
function storedFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return (readdirSync(dir, { recursive: true }) as string[]).filter((name) => name.endsWith('.bin')).map((name) => join(dir, name))
}

function sseChunk(i: number): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: `token ${i} `.repeat(20) } }] })}\n\n`
}

/** The whole answer the fake buyer streams. */
const FULL_ANSWER = Array.from({ length: CHUNKS }, (_, i) => sseChunk(i)).join('') + 'data: [DONE]\n\n'

/** A buyer that streams an answer slowly, and notes whether a request was cut off before it finished. */
async function streamingBuyer(intervalMs = 10) {
  let requests = 0
  let cancelled = 0
  let completed = 0
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      requests++
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-antseed-request-id': `req-${requests}` })
      let i = 0
      const timer = setInterval(() => {
        if (i < CHUNKS) {
          res.write(sseChunk(i++))
          return
        }
        clearInterval(timer)
        res.end('data: [DONE]\n\n')
        completed++
      }, intervalMs)
      res.on('close', () => {
        if (!res.writableFinished) {
          clearInterval(timer)
          cancelled++
        }
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    get requests() { return requests },
    get cancelled() { return cancelled },
    get completed() { return completed },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

async function startGateway(store: GatewayStore, buyerPort: number, streamResume: StreamResumeStore | null) {
  const accounting = new GatewayAccounting(store, { holdUsdc: 300_000, settleGraceMs: 50 })
  const feed = new SpendFeedPoller({ buyerPort, onPage: (page) => { accounting.ingest(page.bootId, page.events) }, intervalMs: 60_000 })
  const logs: string[] = []
  const server = new GatewayServer({
    store,
    accounting,
    buyerPort,
    identityAddress: async () => null,
    spendFeedState: () => feed.state,
    refreshSpendFeed: () => feed.pollOnce(),
    onLog: (message) => logs.push(message),
    // Lets a request carry a routing requirement (a TEE seller) to the buyer.
    controlSecret: 'test-secret',
    streamResume,
  })
  const port = await server.start()
  let stopped = false
  return {
    port,
    logs,
    stop: async () => {
      if (stopped) return
      stopped = true
      await server.stop()
      accounting.dispose()
    },
  }
}

const BODY = JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'write a long answer' }] })

/** Sends a streamed chat request; `dropAfterBytes` cuts the connection once that much has arrived. */
function chat(port: number, secret: string, options: { body?: string; dropAfterBytes?: number; headers?: http.OutgoingHttpHeaders } = {}) {
  return new Promise<{ status: number; body: string; dropped: boolean }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...options.headers },
    }, (res) => {
      const chunks: Buffer[] = []
      let received = 0
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        received += chunk.length
        if (options.dropAfterBytes !== undefined && received >= options.dropAfterBytes) {
          req.destroy()
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), dropped: true })
        }
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), dropped: false }))
      res.on('error', () => {})
    })
    req.on('error', (error) => { if (options.dropAfterBytes === undefined) reject(error) })
    req.end(options.body ?? BODY)
  })
}

async function withGateway(
  options: Partial<StreamResumeOptions> | null,
  run: (ctx: { port: number; secret: string; buyer: Awaited<ReturnType<typeof streamingBuyer>>; resume: StreamResumeStore | null; dir: string; logs: string[]; store: GatewayStore; stopGateway: () => Promise<void> }) => Promise<void>,
): Promise<void> {
  const { store, dir, cleanup } = tempDataDir()
  const buyer = await streamingBuyer()
  const resumeDir = join(dir, 'stream-resume')
  // Long enough that a retry under load never races the grace period; the expiry test sets its own.
  const resume = options === null ? null : new StreamResumeStore({ dir: resumeDir, graceMs: 10_000, ...options })
  resume?.prepare()
  const gateway = await startGateway(store, buyer.port, resume)
  const { secret } = store.createKey({ label: 'Test', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  try {
    await run({ port: gateway.port, secret, buyer, resume, dir: resumeDir, logs: gateway.logs, store, stopGateway: gateway.stop })
  } finally {
    await gateway.stop()
    await buyer.close()
    cleanup()
  }
}

test('a retry after a dropped stream gets the whole answer from the one generation', async () => {
  await withGateway({}, async ({ port, secret, buyer, resume, logs }) => {
    const first = await chat(port, secret, { dropAfterBytes: 2_000 })
    assert.equal(first.dropped, true)
    await waitFor(() => logs.some((line) => line.includes('kept for its retry')))
    const retry = await chat(port, secret)
    assert.equal(retry.status, 200)
    assert.equal(retry.body, FULL_ANSWER)
    // One generation, never cancelled, and nothing left kept once delivered.
    assert.equal(buyer.requests, 1)
    assert.equal(buyer.cancelled, 0)
    await waitFor(() => resume!.size === 0)
    assert.equal(resume!.storedBytes, 0)
    assert.equal(logs.some((line) => line.includes('resumed a dropped stream')), true)
  })
})

test('a stream kept on disk replays from its file and leaves no file behind', async () => {
  // Tiny blocks and memory, so the answer moves to a file early.
  await withGateway({ blockBytes: 256, memoryBytes: 512 }, async ({ port, secret, buyer, resume, dir, logs }) => {
    await chat(port, secret, { dropAfterBytes: 4_000 })
    await waitFor(() => logs.some((line) => line.includes('kept for its retry')))
    await waitFor(() => storedFiles(dir).length === 1)
    const retry = await chat(port, secret)
    assert.equal(retry.body, FULL_ANSWER)
    assert.equal(buyer.requests, 1)
    await waitFor(() => resume!.size === 0 && storedFiles(dir).length === 0)
  })
})

test('a retry that arrives after the answer finished still gets all of it', async () => {
  await withGateway({}, async ({ port, secret, buyer, logs }) => {
    await chat(port, secret, { dropAfterBytes: 1_000 })
    await waitFor(() => logs.some((line) => line.includes('kept for its retry')))
    await waitFor(() => buyer.completed === 1)
    const retry = await chat(port, secret)
    assert.equal(retry.body, FULL_ANSWER)
    assert.equal(buyer.requests, 1)
  })
})

test('a dropped stream nobody comes back for is cancelled after the grace period', async () => {
  await withGateway({ graceMs: 50 }, async ({ port, secret, buyer, resume, store }) => {
    await chat(port, secret, { dropAfterBytes: 1_000 })
    await waitFor(() => buyer.cancelled === 1)
    assert.equal(buyer.completed, 0)
    await waitFor(() => resume!.size === 0)
    // Logged as a client that left, as a cancelled stream was before.
    await waitFor(() => store.listRequests({})[0]?.status === 499)
    assert.equal(store.listRequests({})[0]?.errorCode, 'client_closed_request')
  })
})

test('a different request is not handed a dropped stream', async () => {
  await withGateway({}, async ({ port, secret, buyer, logs }) => {
    await chat(port, secret, { dropAfterBytes: 1_000 })
    await waitFor(() => logs.some((line) => line.includes('kept for its retry')))
    const other = await chat(port, secret, { body: BODY.replace('long answer', 'short answer') })
    assert.equal(other.body, FULL_ANSWER)
    assert.equal(buyer.requests, 2)
  })
})

test('a stream too large to keep is cancelled on a drop, as before', async () => {
  await withGateway({ blockBytes: 256, maxStreamBytes: 300 }, async ({ port, secret, buyer, resume }) => {
    await chat(port, secret, { dropAfterBytes: 4_000 })
    await waitFor(() => buyer.cancelled === 1)
    await waitFor(() => resume!.size === 0)
  })
})

test('without stream resume a dropped client cancels its generation', async () => {
  await withGateway(null, async ({ port, secret, buyer }) => {
    await chat(port, secret, { dropAfterBytes: 1_000 })
    await waitFor(() => buyer.cancelled === 1)
    const retry = await chat(port, secret)
    assert.equal(retry.body, FULL_ANSWER)
    assert.equal(buyer.requests, 2)
  })
})

test('a retry with a different routing requirement is not handed a dropped stream', async () => {
  await withGateway({}, async ({ port, secret, buyer, logs }) => {
    await chat(port, secret, { dropAfterBytes: 1_000 })
    await waitFor(() => logs.some((line) => line.includes('kept for its retry')))
    // The same body, now requiring a TEE seller: the dropped answer was not generated under that requirement.
    const tee = await chat(port, secret, { headers: { 'x-antseed-require-tee': 'true' } })
    assert.equal(tee.body, FULL_ANSWER)
    assert.equal(buyer.requests, 2)
    assert.equal(logs.some((line) => line.includes('resumed a dropped stream')), false)
  })
})

test('stopping the gateway lets a client reading a stream finish it, and cancels one waiting for a retry', async () => {
  await withGateway({}, async ({ port, secret, buyer, logs, resume, stopGateway }) => {
    // One stream waits for a retry that a stopping gateway can no longer take.
    await chat(port, secret, { dropAfterBytes: 1_000 })
    await waitFor(() => logs.some((line) => line.includes('kept for its retry')))
    // Another is being read.
    const reading = chat(port, secret, { body: BODY.replace('long answer', 'other answer') })
    await waitFor(() => buyer.requests === 2)
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Bounded: a stop that cut the stream off would leave the client waiting through the whole drain.
    const stopping = stopGateway()
    const delivered = await Promise.race([reading, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000))])
    assert.equal(delivered?.body, FULL_ANSWER, 'the client reading a stream gets it all while the gateway stops')
    await stopping
    assert.equal(buyer.cancelled, 1)
    assert.equal(buyer.completed, 1)
    assert.equal(resume!.size, 0)
  })
})

test('a slow retry holds the buyer back while the recorded part replays', async () => {
  const { dir, cleanup } = tempDataDir()
  const store = new StreamResumeStore({ dir: join(dir, 'stream-resume'), blockBytes: 1024 })
  store.prepare()
  const source = { paused: false, pause() { this.paused = true }, resume() { this.paused = false } } satisfies StreamSource & { paused: boolean }
  const stream = store.start('fingerprint', 'tag', 200, { 'content-type': 'text/event-stream' }, source, () => {})!
  // A first client that read nothing and dropped: a few MiB are recorded.
  const first = new http.ServerResponse(new http.IncomingMessage(null as never))
  stream.attach(first)
  first.destroy()
  const big = Buffer.alloc(256 * 1024, 'a')
  stream.detach(first)
  for (let i = 0; i < 16; i++) stream.append(big)
  // A retry whose writes stay blocked until it is told to drain, whatever the socket buffers would take.
  const retry = Object.assign(new EventEmitter(), {
    blocked: true,
    received: 0,
    writes: 0,
    writableFinished: false,
    writeHead() { return retry },
    write(chunk: Buffer) { retry.writes++; retry.received += chunk.length; return !retry.blocked },
    end() { retry.writableFinished = true; retry.emit('finish') },
    destroy() { retry.emit('close') },
  })
  try {
    stream.resume(retry as unknown as http.ServerResponse)
    await waitFor(() => retry.writes === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(retry.writes, 1, 'the replay waits for the blocked write')
    assert.equal(source.paused, true, 'the buyer is held back while the replay waits for the client')
    retry.blocked = false
    retry.emit('drain')
    await waitFor(() => retry.received === 16 * big.length)
    await waitFor(() => source.paused === false)
  } finally {
    stream.dispose()
    cleanup()
  }
})

/** Serves `stream.resume()` to one HTTP client; returns its port and a closer. */
async function resumeServer(stream: { resume(res: http.ServerResponse): void }) {
  const server = http.createServer((_req, res) => stream.resume(res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

/** A stream whose first client dropped before reading anything. */
function droppedStream(store: StreamResumeStore, abandon: () => void) {
  const source = { pause() {}, resume() {} } satisfies StreamSource
  const stream = store.start(randomBytes(8).toString('hex'), 'tag', 200, { 'content-type': 'text/event-stream' }, source, abandon)!
  const first = new http.ServerResponse(new http.IncomingMessage(null as never))
  stream.attach(first)
  first.destroy()
  stream.detach(first)
  return stream
}

test('a retry that drops after its answer outgrew the limits cancels the generation', async () => {
  const { dir, cleanup } = tempDataDir()
  const store = new StreamResumeStore({ dir: join(dir, 'stream-resume'), blockBytes: 1024, maxStreamBytes: 64 * 1024 })
  store.prepare()
  let abandoned = 0
  const stream = droppedStream(store, () => { abandoned++ })
  stream.append(Buffer.from('data: first\n\n'))
  const server = await resumeServer(stream)
  try {
    let received = 0
    const req = http.get({ hostname: '127.0.0.1', port: server.port, path: '/' }, (res) => res.on('data', (chunk: Buffer) => { received += chunk.length }))
    req.on('error', () => {})
    await waitFor(() => received > 0)
    // Incompressible output past the per-stream limit: the answer stops being kept, the retry still reads it.
    stream.append(randomBytes(128 * 1024))
    await waitFor(() => !stream.claimable && received > 128 * 1024)
    assert.equal(abandoned, 0, 'a retry still reading keeps its generation')
    req.destroy()
    await waitFor(() => abandoned === 1)
    assert.equal(store.size, 0)
  } finally {
    await server.close()
    store.disposeAll()
    cleanup()
  }
})

test('a second gateway on the same data dir keeps the first one\'s stored streams, and clears folders of gateways that are gone', async () => {
  const { dir, cleanup } = tempDataDir()
  const base = join(dir, 'stream-resume')
  // A folder left by a gateway that is no longer running.
  const stale = join(base, '2147483646-0123456789ab')
  mkdirSync(stale, { recursive: true })
  const first = new StreamResumeStore({ dir: base, blockBytes: 256, memoryBytes: 512 })
  first.prepare()
  assert.equal(existsSync(stale), false)
  const stream = droppedStream(first, () => {})
  for (let i = 0; i < 64; i++) stream.append(Buffer.from(sseChunk(i)))
  await waitFor(() => storedFiles(base).length === 1)
  const [file] = storedFiles(base)
  // Another gateway starts on the same data dir (and may fail to bind): it must not delete the first one's files.
  const second = new StreamResumeStore({ dir: base, pid: 2147483645 })
  second.prepare()
  assert.equal(existsSync(file!), true)
  const server = await resumeServer(stream)
  try {
    stream.end()
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: server.port, path: '/' }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      }).on('error', reject)
    })
    assert.equal(body, Array.from({ length: 64 }, (_, i) => sseChunk(i)).join(''))
  } finally {
    await server.close()
    first.disposeAll()
    second.disposeAll()
    cleanup()
  }
})
