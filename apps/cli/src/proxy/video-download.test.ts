import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { downloadVideo } from './video-download.js'
import type { RequestStreamCallbacks, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node'

const request: SerializedHttpRequest = { requestId: 'download', method: 'POST', path: '/api/v1/video/retrieve', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"queue_id":"task"}') }
const video = Buffer.alloc(3 * 1024 * 1024 + 17, 42)
const start: SerializedHttpResponse = { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(video.length) }, body: new Uint8Array() }

async function serve(send: (request: SerializedHttpRequest, callbacks: RequestStreamCallbacks, signal: AbortSignal) => Promise<SerializedHttpResponse>, run: (url: string) => Promise<void>) {
  const server = createServer((_incoming, response) => {
    const abort = new AbortController()
    response.on('close', () => abort.abort())
    void downloadVideo(request, response, send, abort.signal)
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
    return start
  }, async url => {
    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), video)
  })
  assert.equal(calls, 1)
})

test('returns errors before a stream starts', async () => {
  for (const status of [404, 409, 410, 413, 429, 504]) {
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
    assert.deepEqual(await response.json(), { status: 'PROCESSING' })
    assert.deepEqual(Buffer.from(sentBody!), body)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('passes allowed seller error codes through and hides unknown ones', async () => {
  const sellerError = (statusCode: number, code: string): SerializedHttpResponse => ({
    requestId: request.requestId, statusCode, headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ error: { code, message: 'internal detail' } })),
  })
  for (const [statusCode, code, expectedStatus, expectedCode] of [
    [502, 'video_download_failed', 502, 'video_download_failed'],
    [504, 'video_download_failed', 504, 'video_download_failed'],
    [502, 'video_status_unavailable', 502, 'video_status_unavailable'],
    [500, 'secret_internal_code', 502, 'video_download_unavailable'],
  ] as const) {
    await serve(async () => sellerError(statusCode, code), async url => {
      const response = await fetch(url)
      assert.equal(response.status, expectedStatus)
      const body = await response.json() as { error: { code: string, message: string } }
      assert.equal(body.error.code, expectedCode)
      assert.equal(body.error.message, 'Video download unavailable')
    })
  }
})
