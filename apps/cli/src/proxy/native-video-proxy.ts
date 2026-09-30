import { nativeVideoAcceptance, type NativeVideoRoute, type SerializedHttpResponse } from '@antseed/api-adapter'
import type { ResourceRoute, ResourceRoutes } from './resource-routes.js'

export interface VideoRequestError {
  statusCode: number
  body: { error: { code: string; message: string } }
}

/**
 * Prepares a native video request before seller selection.
 *
 * A create may go to any seller that serves the model. Status and download
 * requests must go back to the exact seller, provider and service that accepted the job,
 * because only that seller knows the job ID.
 */
export function prepareVideoRequest(
  route: NativeVideoRoute,
  headers: Record<string, string>,
  routes: ResourceRoutes,
): { headers: Record<string, string> } | { error: VideoRequestError } {
  if (route.action === 'create') {
    // A create that builds on an earlier job (a Seedance draft) must go to the
    // seller that ran it; the draft does not exist anywhere else.
    const referenced = (route.referencedResourceIds ?? []).map(id => id ? routes.resolve(route.protocol, id) : null)
    if (referenced.some(job => !job || job.sellerPeerId !== referenced[0]!.sellerPeerId)) {
      return { error: { statusCode: 404, body: { error: { code: 'video_route_not_found', message: 'Unknown referenced video job' } } } }
    }
    return { headers: { ...headers, ...(referenced[0] ? pinHeaders(referenced[0]) : {}) } }
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

/**
 * Tags a seller's video response for the client and remembers which seller
 * accepted a new job, so later status and download requests route back to it.
 * Returns true when a new job route was recorded and should be persisted.
 */
export function recordVideoAcceptance(
  route: NativeVideoRoute,
  response: SerializedHttpResponse,
  seller: { peerId: string; provider: string; service: string | null },
  routes: ResourceRoutes,
): boolean {
  response.headers['x-antseed-seller-peer'] = seller.peerId
  if (route.action !== 'create') return false
  const resourceId = nativeVideoAcceptance(route.protocol, response)
  if (!resourceId || !seller.service) return false
  routes.record({ protocol: route.protocol, resourceId, sellerPeerId: seller.peerId.toLowerCase(), provider: seller.provider, service: seller.service })
  return true
}
