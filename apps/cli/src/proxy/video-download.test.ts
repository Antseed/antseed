import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { downloadVideo } from './video-download.js'
import type { RequestStreamCallbacks, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node'

const request: SerializedHttpRequest = { requestId: 'download', method: 'POST', path: '/api/v1/video/retrieve', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"queue_id":"task"}') }
const video = Buffer.alloc(3 * 1024 * 1024 + 17, 42)
const start: SerializedHttpResponse = { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(video.length) }, body: new Uint8Array() }
/** The final answer once the buyer accepted the file as the finished video. */
const accepted: SerializedHttpResponse = { ...start, headers: { ...start.headers, 'x-antseed-video-delivered': '1' } }

async function serve(send: (request: SerializedHttpRequest, callbacks: RequestStreamCallbacks, signal: AbortSignal) => Promise<SerializedHttpResponse>, run: (url: string) => Promise<void>, retire?: () => Promise<boolean>) {
  const server = createServer((_incoming, response) => {
    const abort = new AbortController()
    response.on('close', () => abort.abort())
    void downloadVideo(request, response, send, abort.signal, retire)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`) }
  finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test('streams several MB with one request and no ranges', async () => {
  let calls = 0
  await serve(async (sent, callbacks) => {
    calls += 1
    assert.equal(sent.headers.range, undefined)
    assert.equal(sent.headers['x-antseed-video-download'], 'video-stream-v1')
    callbacks.onResponseStart!(start, { streaming: true })
    for (let offset = 0; offset < video.length; offset += 65536) {
      await callbacks.onResponseChunk!({ requestId: sent.requestId, data: video.subarray(offset, offset + 65536), done: false })
    }
    return accepted
  }, async url => {
    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), video)
  })
  assert.equal(calls, 1)
})

test('cuts off a stream the buyer did not accept as the finished video, so it never ends like a delivery, and retires the job', async () => {
  let retired = 0
  await serve(async (sent, callbacks) => {
    callbacks.onResponseStart!(start, { streaming: true })
    await callbacks.onResponseChunk!({ requestId: sent.requestId, data: video, done: false })
    // A complete, well-formed stream that the buyer did not accept (too short or unreadable): not charged, not delivered.
    return start
  }, async url => {
    const response = await fetch(url)
    assert.equal(response.status, 200)
    await assert.rejects(response.arrayBuffer())
  }, async () => { retired += 1; return true })
  // It would only be rejected again: retired, so the next poll says it is gone and a gateway stops holding its price.
  assert.equal(retired, 1)
})

test('cuts off a good video whose delivery the buyer could not save, but keeps its job for another download', async () => {
  let retired = 0
  const unrecorded: SerializedHttpResponse = { ...start, headers: { ...start.headers, 'x-antseed-video-delivered': 'unrecorded' } }
  await serve(async (sent, callbacks) => {
    callbacks.onResponseStart!(start, { streaming: true })
    await callbacks.onResponseChunk!({ requestId: sent.requestId, data: video, done: false })
    return unrecorded
  }, async url => {
    const response = await fetch(url)
    await assert.rejects(response.arrayBuffer())
  }, async () => { retired += 1; return true })
  assert.equal(retired, 0)
})

test('returns errors before a stream starts', async () => {
  for (const status of [404, 409, 410, 413, 429]) {
    await serve(async () => ({ ...start, statusCode: status }), async url => {
      const response = await fetch(url)
      assert.equal(response.status, status)
      await response.arrayBuffer()
    })
  }
})

test('rejects missing and oversized lengths', async () => {
  for (const length of ['', '4294967296']) {
    await serve(async (_request, callbacks) => {
      callbacks.onResponseStart!({ ...start, headers: { ...start.headers, 'content-length': length } }, { streaming: true })
      return start
    }, async url => {
      const response = await fetch(url)
      assert.equal(response.status, 502)
      await response.arrayBuffer()
    })
  }
})

test('destroys truncated streams instead of appending JSON', async () => {
  await serve(async (_request, callbacks) => {
    callbacks.onResponseStart!(start, { streaming: true })
    await callbacks.onResponseChunk!({ requestId: request.requestId, data: video.subarray(0, 65536), done: false })
    throw new Error('upstream failed')
  }, async url => {
    await assert.rejects(async () => { const response = await fetch(url); await response.arrayBuffer() })
  })
})

test('propagates client disconnect to the single download request', async () => {
  let cancelled!: () => void
  const cancellation = new Promise<void>(resolve => { cancelled = resolve })
  await serve(async (_request, callbacks, signal) => {
    callbacks.onResponseStart!(start, { streaming: true })
    await callbacks.onResponseChunk!({ requestId: request.requestId, data: video.subarray(0, 65536), done: false })
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled(); resolve() }, { once: true }))
    return start
  }, async url => {
    const response = await fetch(url)
    await response.body!.cancel()
    await cancellation
  })
})

test('forwards a POST download body and passes JSON status answers through', async () => {
  const body = Buffer.from('{"model":"wan-2.5","queue_id":"q"}')
  const venice: SerializedHttpRequest = { requestId: 'venice', method: 'POST', path: '/api/v1/video/retrieve', headers: {}, body }
  let sentBody: Uint8Array | undefined
  const server = createServer((_incoming, response) => {
    void downloadVideo(venice, response, async sent => {
      sentBody = sent.body
      return { requestId: sent.requestId, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"status":"PROCESSING"}') }
    }, new AbortController().signal)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'processing', upstream_status: 'PROCESSING' })
    assert.deepEqual(Buffer.from(sentBody!), body)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('passes seller JSON errors below 500 through unchanged', async () => {
  await serve(async sent => ({
    requestId: sent.requestId, statusCode: 404, headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ error: { code: 'resource_not_found', message: 'Video job not found' } })),
  }), async url => {
    const response = await fetch(url)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: { code: 'resource_not_found', message: 'Video job not found' } })
  })
})

test('reports a reachable seller that cannot read the job state as unknown, not 502', async () => {
  const sellerError = (statusCode: number, code: string): SerializedHttpResponse => ({
    requestId: request.requestId, statusCode, headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ error: { code, message: 'internal detail' } })),
  })
  for (const [statusCode, code, expectedCode] of [
    [502, 'video_status_unavailable', 'video_status_unavailable'],
    [502, 'video_download_failed', 'video_download_failed'],
    [504, 'video_download_failed', 'video_download_failed'],
    [503, 'resource_ownership_unavailable', 'resource_ownership_unavailable'],
    [500, 'secret_internal_code', 'video_status_unavailable'],
  ] as const) {
    await serve(async () => sellerError(statusCode, code), async url => {
      const response = await fetch(url)
      assert.equal(response.status, 200)
      const body = await response.json() as { status: string, retryable: boolean, error: { code: string } }
      assert.equal(body.status, 'unknown')
      assert.equal(body.retryable, true)
      assert.equal(body.error.code, expectedCode)
    })
  }
})

test('maps every seller status word to one vocabulary', async () => {
  for (const [upstream, expected] of [
    ['IN_QUEUE', 'processing'], ['IN_PROGRESS', 'processing'], ['QUEUED', 'processing'],
    ['FAILED', 'failed'], ['CANCELLED', 'failed'], ['error', 'failed'],
  ] as const) {
    await serve(async sent => ({
      requestId: sent.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ status: upstream, error: 'reason' })),
    }), async url => {
      const response = await fetch(url)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { status: expected, upstream_status: upstream, error: 'reason' })
    })
  }
})

test('reports a completed status without an MP4 as failed', async () => {
  await serve(async sent => ({
    requestId: sent.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ status: 'completed', video_url: '/v1/video/file/job-1' })),
  }), async url => {
    const response = await fetch(url)
    assert.equal(response.status, 200)
    const body = await response.json() as { status: string, upstream_status: string, video_url?: string, error: { code: string } }
    assert.equal(body.status, 'failed')
    assert.equal(body.upstream_status, 'completed')
    assert.equal(body.error.code, 'video_not_delivered')
    assert.equal(body.video_url, undefined)
  })
})

test('reports an unreachable seller as seller_unreachable and keeps the job', async () => {
  await serve(async () => { throw new Error('Connection to peer failed during request') }, async url => {
    const response = await fetch(url)
    assert.equal(response.status, 502)
    const body = await response.json() as { status: string, retryable: boolean, error: { code: string } }
    assert.equal(body.status, 'seller_unreachable')
    assert.equal(body.retryable, true)
    assert.equal(body.error.code, 'video_download_failed')
  })
})

test('reports a broken stream start from a reachable seller as a failed download', async () => {
  await serve(async (_request, callbacks) => {
    callbacks.onResponseStart!({ ...start, headers: { 'content-type': 'text/html' } }, { streaming: true })
    return start
  }, async url => {
    const response = await fetch(url)
    assert.equal(response.status, 502)
    const body = await response.json() as { status?: string, error: { code: string } }
    assert.equal(body.status, undefined)
    assert.equal(body.error.code, 'video_download_failed')
  })
})
