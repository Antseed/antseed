import type { ServiceHealth } from '../discovery/peer-metadata.js';
import { describeServiceHealth, SELLER_SELF_HEALTH_FAILING_CODE } from '../discovery/peer-metadata.js';
import type { SerializedHttpResponse } from '../types/http.js';
import { tryParseJsonObject } from '../utils/json-codec.js';
import { isContentFreeLogging, upstreamErrorCode } from '../utils/debug.js';
import { isUpstreamOutOfCredit } from './upstream-credit.js';

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

/**
 * Whether an upstream error is about the seller's own account: its key
 * (401, 403) or its credit. This decides what buyers are shown, so it reads
 * a billing error at any status; a buyer who gets its own input echoed back
 * this way only gets a 503 instead of a 400. Health checks read the account
 * more carefully (`isLiveResponseOutOfCredit`).
 */
export function isUpstreamAccountError(statusCode: number, text: string): boolean {
  return statusCode === 401 || statusCode === 403 || (statusCode >= 400 && isUpstreamOutOfCredit(statusCode, text));
}

/** Token-like runs (keys, bearer tokens, account ids) an upstream message can quote. */
const TOKEN_LIKE_PATTERN = /[A-Za-z0-9_\-.]{24,}/g;
const MAX_LOGGED_MESSAGE_CHARS = 200;

/**
 * The message of an upstream error body: `error.message`, or `error` when it
 * is a string. Not JSON (or cut off at the read limit): the raw text. An error
 * object without a message has none.
 */
function upstreamErrorMessage(body: string): string {
  const error = tryParseJsonObject(new TextEncoder().encode(body))?.['error'];
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return error ? '' : body;
}

/**
 * The upstream error behind a 503 a buyer got, for the seller's own log: the
 * status, the error type and, outside content-free mode, the message with
 * anything token-like redacted.
 */
export function describeUpstreamError(statusCode: number, body: string): string {
  const code = upstreamErrorCode(body);
  const head = code ? `HTTP ${statusCode} ${code}` : `HTTP ${statusCode}`;
  if (isContentFreeLogging()) return head;
  const text = upstreamErrorMessage(body).replace(TOKEN_LIKE_PATTERN, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, MAX_LOGGED_MESSAGE_CHARS);
  return text ? `${head}: ${text}` : head;
}

/** Error code a seller answers with when its upstream account (credit or key) fails a request. */
export const UPSTREAM_UNAVAILABLE_CODE = 'upstream_unavailable';

/**
 * What a buyer gets for an upstream answer about the seller's account (out of
 * credit, key rejected): the seller's account is not the buyer's business (and
 * a 402 would read as a request to pay), so it is a 503 saying the service is
 * unavailable, without the upstream's message, type or headers.
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

/**
 * Error code of a seller's own answer that all its video download slots are
 * taken. It is the seller's busy signal, not the upstream's, so it reaches the
 * buyer unchanged, with its `retry-after`.
 */
export const VIDEO_DOWNLOAD_BUSY_CODE = 'video_download_busy';

/** Whether a provider's 429 body is the seller's own download-busy answer. */
export function isVideoDownloadBusy(statusCode: number, text: string): boolean {
  if (statusCode !== 429 || !text.includes(VIDEO_DOWNLOAD_BUSY_CODE)) return false;
  const error = tryParseJsonObject(text)?.['error'];
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: unknown }).code === VIDEO_DOWNLOAD_BUSY_CODE;
}

/** Error code a seller answers with when its upstream rate or usage limits a request. */
export const UPSTREAM_RATE_LIMITED_CODE = 'upstream_rate_limited';

/**
 * What a buyer gets for an upstream 429: still a 429 with the upstream's
 * `retry-after`, so buyers back off or retry as before, but none of the
 * upstream's body, which can name the seller's plan and when its limit resets.
 */
export function buildUpstreamRateLimitedResponse(requestId: string, service: string, retryAfter: string | undefined): SerializedHttpResponse {
  return {
    requestId,
    statusCode: 429,
    headers: { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) },
    body: new TextEncoder().encode(JSON.stringify({
      error: {
        type: UPSTREAM_RATE_LIMITED_CODE,
        code: UPSTREAM_RATE_LIMITED_CODE,
        message: `${service} is rate limited on this seller right now`,
        service,
      },
    })),
  };
}
