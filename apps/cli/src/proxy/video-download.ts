import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import { VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION, VIDEO_DOWNLOAD_MAX_BYTES, type RequestStreamCallbacks, type SerializedHttpRequest, type SerializedHttpResponse } from '@antseed/node'

type SendDownload = (request: SerializedHttpRequest, callbacks: RequestStreamCallbacks, signal: AbortSignal) => Promise<SerializedHttpResponse>
let activeDownloads = 0

/** Seller error codes safe to pass to clients, so they can tell a temporary failure from a lasting one. */
const SELLER_ERROR_CODES = new Set([
  'video_download_failed', 'video_download_unavailable', 'video_download_busy', 'video_status_unavailable',
  'unsupported_video_download', 'unsupported_video_request', 'resource_ownership_unavailable',
])
const RETURNED_STATUSES = new Set([400, 404, 409, 410, 413, 429, 502, 503, 504])

function sellerErrorCode(body: Uint8Array): string | null {
  if (body.length > 4096) return null
  try {
    const code = (JSON.parse(Buffer.from(body).toString('utf8')) as { error?: { code?: unknown } })?.error?.code
    return typeof code === 'string' && SELLER_ERROR_CODES.has(code) ? code : null
  } catch {
    return null
  }
}

/** Streams a finished video from the seller that owns the job to the client. */
export async function downloadVideo(request: SerializedHttpRequest, response: ServerResponse, send: SendDownload, clientSignal: AbortSignal): Promise<void> {
  const error = (status: number, code: string) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ error: { code, message: 'Video download unavailable' } }))
  }
  if (activeDownloads >= 2) { error(429, 'video_download_busy'); return }
  activeDownloads += 1
  const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(5 * 60_000)])
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !['range', 'if-range', 'content-length', 'accept-encoding'].includes(key.toLowerCase())))
  let length: number | null = null
  let received = 0
  try {
    const body = request.method === 'GET' ? new Uint8Array(0) : request.body
    const result = await send({ ...request, headers: { ...headers, [VIDEO_DOWNLOAD_STREAM_HEADER]: VIDEO_DOWNLOAD_STREAM_VERSION }, body }, {
      onResponseStart: (start, metadata) => {
        if (!metadata.streaming) return
        const lengthHeader = start.headers['content-length']
        length = lengthHeader === undefined ? null : Number(lengthHeader)
        if (start.statusCode !== 200 || start.headers['content-type'] !== 'video/mp4'
          || (length !== null && (!Number.isSafeInteger(length) || length <= 0 || length > VIDEO_DOWNLOAD_MAX_BYTES))) throw new Error('Invalid video stream')
        response.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      },
      onResponseChunk: async chunk => {
        signal.throwIfAborted()
        received += chunk.data.length
        if (received > VIDEO_DOWNLOAD_MAX_BYTES || (length !== null && received > length)) throw new Error('Invalid video size')
        if (chunk.data.length && !response.write(Buffer.from(chunk.data))) await once(response, 'drain', { signal })
      },
    }, signal)
    signal.throwIfAborted()
    if (!response.headersSent) {
      // A JSON answer instead of a stream: a status such as Venice "PROCESSING", or a seller error.
      if (result.headers['content-type']?.startsWith('application/json') && result.statusCode < 500) {
        response.writeHead(result.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(Buffer.from(result.body))
        return
      }
      const code = result.headers['content-type']?.startsWith('application/json') ? sellerErrorCode(result.body) : null
      error(RETURNED_STATUSES.has(result.statusCode) ? result.statusCode : 502, code ?? 'video_download_unavailable')
      return
    }
    if (result.statusCode !== 200 || (length !== null && received !== length)) throw new Error('Incomplete video')
    response.end()
  } catch {
    if (response.headersSent || clientSignal.aborted) response.destroy()
    else error(signal.aborted ? 504 : 502, 'video_download_failed')
  } finally {
    activeDownloads -= 1
  }
}
