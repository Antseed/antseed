import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import * as http from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { GatewayAccounting } from './accounting.js'
import { tempDataDir } from './console-api/test-support.js'
import { GatewayServer } from './server.js'
import { SpendFeedPoller } from './spend-feed.js'
import type { GatewayStore } from './store.js'
import { StreamResumeStore, type StreamResumeOptions } from './stream-resume.js'

const NO_LIMITS = { daily: null, monthly: null, total: null }
const CHUNKS = 40

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
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
    streamResume,
  })
  const port = await server.start()
  return { port, logs, stop: async () => { await server.stop(); accounting.dispose() } }
}

const BODY = JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'write a long answer' }] })

/** Sends a streamed chat request; `dropAfterBytes` cuts the connection once that much has arrived. */
function chat(port: number, secret: string, options: { body?: string; dropAfterBytes?: number } = {}) {
  return new Promise<{ status: number; body: string; dropped: boolean }>((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
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
  run: (ctx: { port: number; secret: string; buyer: Awaited<ReturnType<typeof streamingBuyer>>; resume: StreamResumeStore | null; dir: string; logs: string[]; store: GatewayStore }) => Promise<void>,
): Promise<void> {
  const { store, dir, cleanup } = tempDataDir()
  const buyer = await streamingBuyer()
  const resumeDir = join(dir, 'stream-resume')
  const resume = options === null ? null : new StreamResumeStore({ dir: resumeDir, graceMs: 500, ...options })
  resume?.prepare()
  const gateway = await startGateway(store, buyer.port, resume)
  const { secret } = store.createKey({ label: 'Test', buyerIdentity: DEFAULT_BUYER_IDENTITY, limits: NO_LIMITS, expiresAt: null })
  try {
    await run({ port: gateway.port, secret, buyer, resume, dir: resumeDir, logs: gateway.logs, store })
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
    await waitFor(() => readdirSync(dir).length === 1)
    const retry = await chat(port, secret)
    assert.equal(retry.body, FULL_ANSWER)
    assert.equal(buyer.requests, 1)
    await waitFor(() => resume!.size === 0 && readdirSync(dir).length === 0)
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
