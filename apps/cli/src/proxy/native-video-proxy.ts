import { randomUUID } from 'node:crypto'
import { nativeVideoAcceptance, veoDownloadPath, type NativeVideoRoute, type SerializedHttpResponse } from '@antseed/api-adapter'
import type { ResourceRoute, ResourceRoutes } from './resource-routes.js'
import { VIDEO_DOWNLOAD_STREAM_VERSION } from '@antseed/node'

// Video creates are charged when the seller accepts the job. If that acceptance
// response is lost, a retry must carry the same key so the seller can return the
// stored acceptance instead of creating and charging a second job. The buyer
// proxy assigns the key because native video clients do not send one.
export const VIDEO_IDEMPOTENCY_KEY_HEADER = 'x-antseed-idempotency-key'
const VIDEO_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

// The seller's stored acceptance only prevents a second charge if the retry
// reaches that same seller. Each create is recorded against its idempotency key
// before it is sent, so a retry with the same key is pinned to the original
// seller and fails rather than starting a second paid job elsewhere. Job IDs
// never contain ':', so these entries cannot collide with accepted job routes.
function createAttemptId(idempotencyKey: string): string {
  return `idempotency:${idempotencyKey}`
}

export interface VideoRequestError {
  statusCode: number
  body: { error: { code: string; message: string } }
}

/**
 * Prepares a native video request before seller selection.
 *
 * A create may go to any seller that serves the model and gets an idempotency
 * key for safe client retries. Status and cancel must go back to the exact
 * seller, provider and service that accepted the job, because only that seller
 * knows the job ID.
 */
export function prepareVideoRequest(
  route: NativeVideoRoute,
  headers: Record<string, string>,
  routes: ResourceRoutes,
): { headers: Record<string, string> } | { error: VideoRequestError } {
  if (route.action === 'create') {
    const suppliedKey = (headers[VIDEO_IDEMPOTENCY_KEY_HEADER] ?? headers['idempotency-key'])?.trim()
    if (suppliedKey !== undefined && !VIDEO_IDEMPOTENCY_KEY_PATTERN.test(suppliedKey)) {
      return { error: { statusCode: 400, body: { error: { code: 'invalid_idempotency_key', message: 'Idempotency key must be 1-128 characters of [A-Za-z0-9._:-]' } } } }
    }
    const idempotencyKey = suppliedKey || randomUUID()
    // A create that builds on an earlier job (a Seedance draft) must go to the
    // seller that ran it; the draft does not exist anywhere else.
    const referenced = (route.referencedResourceIds ?? []).map(id => id ? routes.resolve(route.protocol, id) : null)
    if (referenced.some(job => !job || job.sellerPeerId !== referenced[0]!.sellerPeerId)) {
      return { error: { statusCode: 404, body: { error: { code: 'video_route_not_found', message: 'Unknown referenced video job' } } } }
    }
    const previous = routes.resolve(route.protocol, createAttemptId(idempotencyKey)) ?? referenced[0]
    return { headers: { ...headers, [VIDEO_IDEMPOTENCY_KEY_HEADER]: idempotencyKey, ...(previous ? pinHeaders(previous) : {}) } }
  }
  const job = route.resourceId ? routes.resolve(route.protocol, route.resourceId) : null
  if (!job) {
    return { error: { statusCode: 404, body: { error: { code: 'video_route_not_found', message: 'Unknown video job' } } } }
  }
  return { headers: { ...headers, ...pinHeaders(job) } }
}

function pinHeaders(route: ResourceRoute): Record<string, string> {
  return {
    'x-antseed-pin-peer': route.sellerPeerId,
    'x-antseed-provider': route.provider,
    'x-antseed-service': route.service,
  }
}

/** Records which seller receives a create. Returns true when the route should be persisted before sending. */
export function recordVideoCreateAttempt(
  route: NativeVideoRoute,
  requestHeaders: Record<string, string>,
  seller: { peerId: string; provider: string; service: string | null },
  routes: ResourceRoutes,
): boolean {
  const idempotencyKey = requestHeaders[VIDEO_IDEMPOTENCY_KEY_HEADER]
  if (route.action !== 'create' || !idempotencyKey || !seller.service) return false
  routes.record({ protocol: route.protocol, resourceId: createAttemptId(idempotencyKey), sellerPeerId: seller.peerId.toLowerCase(), provider: seller.provider, service: seller.service })
  return true
}

/**
 * Tags a seller's video response for the client and remembers which seller
 * accepted a new job, so later status and cancel requests route back to it.
 * Returns true when a new job route was recorded and should be persisted.
 */
export function recordVideoAcceptance(
  route: NativeVideoRoute,
  requestHeaders: Record<string, string>,
  response: SerializedHttpResponse,
  seller: { peerId: string; provider: string; service: string | null },
  routes: ResourceRoutes,
): boolean {
  response.headers['x-antseed-seller-peer'] = seller.peerId
  if (route.action !== 'create') return false
  response.headers[VIDEO_IDEMPOTENCY_KEY_HEADER] = requestHeaders[VIDEO_IDEMPOTENCY_KEY_HEADER]!
  const resourceId = nativeVideoAcceptance(route.protocol, response)
  if (!resourceId || !seller.service) return false
  routes.record({ protocol: route.protocol, resourceId, sellerPeerId: seller.peerId.toLowerCase(), provider: seller.provider, service: seller.service })
  return true
}

export function rewriteVideoDownloadUrls(
  route: NativeVideoRoute,
  response: SerializedHttpResponse,
  localOrigin: string,
  downloadCapability?: string,
): SerializedHttpResponse {
  if (downloadCapability !== VIDEO_DOWNLOAD_STREAM_VERSION) return response
  if (route.protocol !== 'veo-video' || route.action !== 'status' || response.statusCode !== 200) return response
  let body
  try { body = JSON.parse(Buffer.from(response.body).toString()) } catch { return response }
  const samples = body?.response?.generateVideoResponse?.generatedSamples
  if (body?.done !== true || body.error || !Array.isArray(samples)) return response
  let changed = false
  for (const [index, sample] of samples.entries()) {
    if (index > 999 || typeof sample?.video?.uri !== 'string') continue
    let url
    try { url = new URL(sample.video.uri) } catch { continue }
    if (url.origin !== 'https://generativelanguage.googleapis.com' || !/^\/v1beta\/files\/[A-Za-z0-9_-]+:download$/.test(url.pathname)) continue
    sample.video.uri = new URL(veoDownloadPath(route.resourceId!, index), localOrigin).href
    changed = true
  }
  if (!changed) return response
  const headers = Object.fromEntries(Object.entries(response.headers).filter(([key]) => !['content-length', 'content-encoding', 'etag', 'digest', 'content-md5'].includes(key.toLowerCase())))
  return { ...response, headers, body: Buffer.from(JSON.stringify(body)) }
}
