import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import { VIDEO_DELIVERED_HEADER, VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_JOB_RETIRED_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION, VIDEO_DOWNLOAD_MAX_BYTES, type RequestStreamCallbacks, type SerializedHttpRequest, type SerializedHttpResponse } from '@antseed/node'

type SendDownload = (request: SerializedHttpRequest, callbacks: RequestStreamCallbacks, signal: AbortSignal) => Promise<SerializedHttpResponse>
let activeDownloads = 0

/** Seller error codes safe to pass to clients, so they can tell a temporary failure from a lasting one. */
const SELLER_ERROR_CODES = new Set([
  'video_download_failed', 'video_download_unavailable', 'video_download_busy', 'video_status_unavailable',
  'unsupported_video_download', 'unsupported_video_request', 'resource_ownership_unavailable',
])
const RETURNED_STATUSES = new Set([400, 404, 409, 410, 413, 429])
/** The seller no longer has the job: it can never be delivered. */
const JOB_GONE_STATUSES = new Set([404, 410])
const RETIRED = { [VIDEO_JOB_RETIRED_HEADER]: '1' }
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
 * Streams a finished video, or answers the job's status. Before an answer that
 * ends the job (it failed, including a JSON `completed` with no video, or the
 * seller answers 404/410: it no longer has the job), `retire` must durably
 * retire it; that answer then carries VIDEO_JOB_RETIRED_HEADER. When the job
 * cannot be retired, the answer is a retryable `unknown` instead, so no caller
 * treats the job as finished while it can still be charged.
 */
export async function downloadVideo(
  request: SerializedHttpRequest,
  response: ServerResponse,
  send: SendDownload,
  clientSignal: AbortSignal,
  retire: () => Promise<boolean> = async () => true,
): Promise<void> {
  const reply = (httpStatus: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) => {
    response.writeHead(httpStatus, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders })
    response.end(JSON.stringify(body))
  }
  const error = (httpStatus: number, code: string) => reply(httpStatus, { error: { code, message: 'Video download unavailable' } })
  const pending = (httpStatus: number, status: 'unknown' | 'seller_unreachable', code: string, message: string) =>
    reply(httpStatus, { status, retryable: true, error: { code, message } })
  if (activeDownloads >= 2) { error(429, 'video_download_busy'); return }
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
        const ends = result.statusCode === 200 ? parseObject(answer)?.status === 'failed' : JOB_GONE_STATUSES.has(result.statusCode)
        if (ends && !await retire().catch(() => false)) {
          pending(200, 'unknown', 'video_status_unavailable', 'The video job status could not be recorded; poll again')
          return
        }
        response.writeHead(result.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(ends ? RETIRED : {}) })
        response.end(Buffer.from(answer))
        return
      }
      const code = isJson ? sellerErrorCode(result.body) : null
      if (JOB_GONE_STATUSES.has(result.statusCode)) {
        if (!await retire().catch(() => false)) {
          pending(200, 'unknown', 'video_status_unavailable', 'The video job status could not be recorded; poll again')
          return
        }
        reply(result.statusCode, { error: { code: code ?? 'video_download_unavailable', message: 'Video download unavailable' } }, RETIRED)
        return
      }
      if (RETURNED_STATUSES.has(result.statusCode)) { error(result.statusCode, code ?? 'video_download_unavailable'); return }
      // The seller answered, so it is reachable; it just could not read the job's state right now.
      pending(200, 'unknown', code ?? 'video_status_unavailable', 'The seller could not read the video job status right now; poll again')
      return
    }
    if (result.statusCode !== 200 || (length !== null && received !== length)) throw new Error('Incomplete video')
    // Only a file the buyer accepted as the finished video is a delivery (and is charged). Any other stream is cut
    // off, so no client or gateway takes it for one; the job is retired first (it would only be rejected again), so
    // the next poll answers it is gone and a gateway stops holding its price.
    if (result.headers[VIDEO_DELIVERED_HEADER] !== '1') {
      await retire().catch(() => false)
      throw new Error('Video not accepted')
    }
    response.end()
  } catch {
    if (response.headersSent || clientSignal.aborted) response.destroy()
    else if (sellerAnswered) error(502, 'video_download_failed')
    else pending(signal.aborted ? 504 : 502, 'seller_unreachable', 'video_download_failed', 'The seller holding this video job could not be reached; the job is kept, poll again later')
  } finally {
    activeDownloads -= 1
  }
}
