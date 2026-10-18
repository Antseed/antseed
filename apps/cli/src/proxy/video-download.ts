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
const RETURNED_STATUSES = new Set([400, 404, 409, 410, 413, 429])
const PROCESSING_STATUSES = new Set(['PROCESSING', 'QUEUED', 'PENDING', 'IN_QUEUE', 'IN_PROGRESS', 'RUNNING'])
const FAILED_STATUSES = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'])

/**
 * One status vocabulary for every video seller and plugin version:
 * - `processing` / `failed`: what the seller reported (`upstream_status` keeps its word). A JSON `completed`
 *   becomes `failed` (`video_not_delivered`): a finished video arrives as the MP4 stream itself.
 * - `unknown` (200): the seller answered but could not read the job's state right now; poll again.
 * - `seller_unreachable` (502/504): the seller could not be reached; the job is kept, poll again later.
 */
export type VideoJobStatus = 'processing' | 'failed' | 'completed' | 'unknown' | 'seller_unreachable'

export function normalizeVideoStatus(status: unknown): VideoJobStatus | null {
  if (typeof status !== 'string') return null
  const upper = status.toUpperCase()
  if (PROCESSING_STATUSES.has(upper)) return 'processing'
  if (FAILED_STATUSES.has(upper)) return 'failed'
  if (upper === 'COMPLETED') return 'completed'
  return null
}

function parseObject(body: Uint8Array): Record<string, unknown> | null {
  if (body.length > 1024 * 1024) return null
  try {
    const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** A seller's JSON status answer with `status` mapped to the shared vocabulary; unchanged when it has no known status. */
function withNormalizedStatus(body: Uint8Array): Uint8Array {
  const parsed = parseObject(body)
  const status = normalizeVideoStatus(parsed?.status)
  if (!parsed || !status) return body
  // Finished videos arrive as an MP4 stream, so a JSON "completed" means the seller will not deliver one.
  if (status === 'completed') {
    return Buffer.from(JSON.stringify({
      status: 'failed',
      upstream_status: parsed.status,
      error: { code: 'video_not_delivered', message: 'The seller reported the job as completed but did not send the video' },
    }))
  }
  return Buffer.from(JSON.stringify({ ...parsed, status, upstream_status: parsed.status }))
}

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
/**
 * Streams a finished video, or answers the job's status. Resolves `'failed'`
 * when the answer says the job failed (including a JSON `completed` with no
 * video), so the caller can retire the job.
 */
export async function downloadVideo(request: SerializedHttpRequest, response: ServerResponse, send: SendDownload, clientSignal: AbortSignal): Promise<'failed' | null> {
  const reply = (httpStatus: number, body: Record<string, unknown>) => {
    response.writeHead(httpStatus, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }
  const error = (httpStatus: number, code: string) => reply(httpStatus, { error: { code, message: 'Video download unavailable' } })
  const pending = (httpStatus: number, status: 'unknown' | 'seller_unreachable', code: string, message: string) =>
    reply(httpStatus, { status, retryable: true, error: { code, message } })
  if (activeDownloads >= 2) { error(429, 'video_download_busy'); return null }
  activeDownloads += 1
  const signal = AbortSignal.any([clientSignal, AbortSignal.timeout(5 * 60_000)])
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !['range', 'if-range', 'content-length', 'accept-encoding'].includes(key.toLowerCase())))
  let length: number | null = null
  let received = 0
  let sellerAnswered = false
  try {
    const body = request.method === 'GET' ? new Uint8Array(0) : request.body
    const result = await send({ ...request, headers: { ...headers, [VIDEO_DOWNLOAD_STREAM_HEADER]: VIDEO_DOWNLOAD_STREAM_VERSION }, body }, {
      onResponseStart: (start, metadata) => {
        sellerAnswered = true
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
      const isJson = result.headers['content-type']?.startsWith('application/json') === true
      if (isJson && result.statusCode < 500) {
        const answer = result.statusCode === 200 ? withNormalizedStatus(result.body) : result.body
        response.writeHead(result.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(Buffer.from(answer))
        return result.statusCode === 200 && parseObject(answer)?.status === 'failed' ? 'failed' : null
      }
      const code = isJson ? sellerErrorCode(result.body) : null
      if (RETURNED_STATUSES.has(result.statusCode)) { error(result.statusCode, code ?? 'video_download_unavailable'); return null }
      // The seller answered, so it is reachable; it just could not read the job's state right now.
      pending(200, 'unknown', code ?? 'video_status_unavailable', 'The seller could not read the video job status right now; poll again')
      return null
    }
    if (result.statusCode !== 200 || (length !== null && received !== length)) throw new Error('Incomplete video')
    response.end()
    return null
  } catch {
    if (response.headersSent || clientSignal.aborted) response.destroy()
    else if (sellerAnswered) error(502, 'video_download_failed')
    else pending(signal.aborted ? 504 : 502, 'seller_unreachable', 'video_download_failed', 'The seller holding this video job could not be reached; the job is kept, poll again later')
    return null
  } finally {
    activeDownloads -= 1
  }
}
