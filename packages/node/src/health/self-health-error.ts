import type { ServiceHealth } from '../discovery/peer-metadata.js';
import { describeServiceHealth, SELLER_SELF_HEALTH_FAILING_CODE } from '../discovery/peer-metadata.js';
import type { SerializedHttpResponse } from '../types/http.js';

export { describeServiceHealth, SELLER_SELF_HEALTH_FAILING_CODE };

/** Statuses that say the upstream, not the buyer's request, is at fault. */
export function isUpstreamFailureStatus(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 402 || statusCode === 403 || statusCode === 404
    || statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function upstreamErrorMessage(body: Uint8Array | undefined): string | undefined {
  if (!body || body.length === 0) return undefined;
  const text = new TextDecoder().decode(body.slice(0, 2_000));
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = parsed.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Not JSON: quote the start of the text.
  }
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 300) : undefined;
}

/**
 * The error a buyer gets when a request to a service the seller's own health
 * check marks failing also fails upstream. The status code is kept so buyer
 * retry and failover logic behaves as before; the body says why.
 */
export function buildSelfHealthErrorResponse(
  requestId: string,
  statusCode: number,
  service: string,
  health: ServiceHealth,
  upstreamBody?: Uint8Array,
): SerializedHttpResponse {
  const upstreamMessage = upstreamErrorMessage(upstreamBody);
  const message = `${describeServiceHealth(service, health)}${upstreamMessage ? ` Upstream said: ${upstreamMessage}` : ''}`;
  return {
    requestId,
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      error: {
        type: SELLER_SELF_HEALTH_FAILING_CODE,
        code: SELLER_SELF_HEALTH_FAILING_CODE,
        message,
        service,
        service_health: health,
        upstream_status: statusCode,
      },
    })),
  };
}
