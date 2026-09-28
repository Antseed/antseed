import type { PeerInfo, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node'
import type { BuyerModelRouters } from './model-router-setup.js'
import { computeResponseTelemetry } from './telemetry.js'
import { isCompletionRequestPath } from './conversation-identity.js'

export function recordRouterUsage(
  routers: Pick<BuyerModelRouters, 'recordUsage'> | null,
  conversationKey: string | null,
  request: SerializedHttpRequest,
  response: SerializedHttpResponse,
  peer: PeerInfo,
  signal: AbortSignal,
): void {
  if (!routers || !conversationKey || signal.aborted || !isCompletionRequestPath(request.path)
    || response.statusCode < 200 || response.statusCode >= 300) return
  const telemetry = computeResponseTelemetry(request, response.headers, response.body, peer)
  if (telemetry.usage.source !== 'usage' || telemetry.usage.inputTokens <= 0 || !telemetry.pricing.service) return
  try {
    routers.recordUsage({
      conversationKey, requestId: request.requestId, peerId: peer.peerId,
      provider: telemetry.pricing.provider, serviceId: telemetry.pricing.service,
      inputTokens: telemetry.usage.inputTokens, cachedInputTokens: telemetry.usage.cachedInputTokens,
    })
  } catch {}
}
