import type { ServiceHealth } from '../discovery/peer-metadata.js';
import { describeServiceHealth, SELLER_SELF_HEALTH_FAILING_CODE } from '../discovery/peer-metadata.js';
import type { SerializedHttpResponse } from '../types/http.js';
import { tryParseJsonObject } from '../utils/json-codec.js';

export { describeServiceHealth, SELLER_SELF_HEALTH_FAILING_CODE };

/**
 * Status of a self health error. It is the seller's service that is down, so
 * buyers fail over as for any unavailable seller, and never treat it as their
 * own 401 or as a 402 asking them to pay.
 */
export const SELF_HEALTH_ERROR_STATUS = 503;

/** Statuses that say the upstream, not the buyer's request, is at fault. */
export function isUpstreamFailureStatus(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 402 || statusCode === 403 || statusCode === 404
    || statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

/** Headers about the body or the upstream's own credentials are not carried over. */
const DROPPED_UPSTREAM_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'www-authenticate', 'set-cookie']);
const ERROR_TYPE_PATTERN = /^[a-z0-9_.-]{1,64}$/i;

/** The upstream's error type code (e.g. `insufficient_quota`), when it has one. Its message is never forwarded. */
function upstreamErrorType(body: Uint8Array | undefined): string | undefined {
  if (!body || body.length === 0) return undefined;
  const error = tryParseJsonObject(body.slice(0, 2_000))?.['error'];
  if (!error || typeof error !== 'object') return undefined;
  const { code, type } = error as { code?: unknown; type?: unknown };
  const value = typeof code === 'string' ? code : type;
  return typeof value === 'string' && ERROR_TYPE_PATTERN.test(value) ? value : undefined;
}

/**
 * The error a buyer gets when a request to a service the seller's own health
 * check marks failing also fails upstream. The upstream's rate limit and
 * retry headers are kept; its status and error type move into the body, and
 * its error message (which can quote the seller's credentials) is dropped.
 */
export function buildSelfHealthErrorResponse(
  requestId: string,
  service: string,
  health: ServiceHealth,
  upstream: Pick<SerializedHttpResponse, 'statusCode' | 'headers' | 'body'>,
): SerializedHttpResponse {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(upstream.headers ?? {})) {
    if (!DROPPED_UPSTREAM_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  headers['content-type'] = 'application/json';
  const upstreamType = upstreamErrorType(upstream.body);
  return {
    requestId,
    statusCode: SELF_HEALTH_ERROR_STATUS,
    headers,
    body: new TextEncoder().encode(JSON.stringify({
      error: {
        type: SELLER_SELF_HEALTH_FAILING_CODE,
        code: SELLER_SELF_HEALTH_FAILING_CODE,
        message: describeServiceHealth(service, health),
        service,
        service_health: health,
        upstream_status: upstream.statusCode,
        ...(upstreamType ? { upstream_type: upstreamType } : {}),
      },
    })),
  };
}

/** Error code a seller answers with when its upstream account is out of credit. */
export const UPSTREAM_UNAVAILABLE_CODE = 'upstream_unavailable';

/**
 * What a buyer gets for an upstream answer saying the seller's account is out
 * of credit: the seller's account is not the buyer's business (and a 402 would
 * read as a request to pay), so it is a 503 saying the service is unavailable,
 * without the upstream's message, type or headers.
 */
export function buildUpstreamUnavailableResponse(requestId: string, service: string): SerializedHttpResponse {
  return {
    requestId,
    statusCode: SELF_HEALTH_ERROR_STATUS,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      error: {
        type: UPSTREAM_UNAVAILABLE_CODE,
        code: UPSTREAM_UNAVAILABLE_CODE,
        message: `${service} is unavailable on this seller right now`,
        service,
      },
    })),
  };
}
