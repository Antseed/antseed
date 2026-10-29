import {
  ANTSEED_FAULT_ATTRIBUTION_HEADER,
  type SerializedHttpResponse,
} from '@antseed/protocol/http';
import type { ServiceApiProtocol } from '@antseed/protocol/service-api';

const USER_ACTIONABLE_PEER_ERROR_IDS = new Set([
  'content_policy_violation',
  'context_length_exceeded',
  'invalid_request',
  'invalid_request_error',
  'max_tokens_exceeded',
  'request_too_large',
  'unsupported_parameter',
  'validation_error',
]);

function responseHeader(response: SerializedHttpResponse, name: string): string | undefined {
  const normalized = name.toLowerCase();
  return Object.entries(response.headers)
    .find(([header]) => header.toLowerCase() === normalized)?.[1];
}

type PeerErrorDetails = {
  body: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  id: string | null;
  message: string | null;
};

export interface AdaptPeerFaultErrorOptions {
  pinned?: boolean;
  /** The seller that answered; named in a free-tier limit so clients can link to its pool. */
  peerId?: string;
}

/** Error id of a seller's free-tier 429. */
export const FREE_TIER_EXHAUSTED_ERROR_ID = 'free_tier_exhausted';

/** One staked tier: `minPower` in ANTS-epochs (ANTS × weeks of lock remaining). */
export interface FreeTierLimitStakeTier {
  minPower: number;
  multiplier: number | 'unlimited';
}

/**
 * A seller's free-tier limit, as the buyer passes it on in the `free_tier`
 * field of a 429 body. `stakeTiers` is empty when the seller has no staked
 * program; only stake in this seller's pool counts toward its tiers.
 */
export interface FreeTierLimit {
  peerId: string | null;
  /** `stake_required`: the model is free only for buyers staked on this seller. */
  limitedBy: 'address' | 'ip' | 'stake' | 'stake_required';
  limit: number | null;
  windowMs: number | null;
  retryAfterSeconds: number | null;
  stakeTiers: FreeTierLimitStakeTier[];
  /** The buyer's counted power in this seller's pool, in ANTS-epochs. */
  stakePower: number;
  /** Requests per window that tier multipliers apply to; null from sellers that don't send it. */
  baseLimit: number | null;
  /** The model is served only to buyers whose stake reaches a tier. */
  stakersOnly: boolean;
}

const EPOCHS_PER_YEAR = 52;
const MAX_STAKE_TIERS = 4;

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readStakeTiers(value: unknown): FreeTierLimitStakeTier[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_STAKE_TIERS).flatMap((raw): FreeTierLimitStakeTier[] => {
    const tier = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const minPower = finiteNonNegative(tier.minPower);
    const multiplier = tier.multiplier === 'unlimited' ? 'unlimited' : finiteNonNegative(tier.multiplier);
    return minPower !== null && multiplier !== null ? [{ minPower, multiplier }] : [];
  }).sort((a, b) => a.minPower - b.minPower);
}

/** The free-tier limit in a seller's 429 body, or null when the body is not one. */
export function readFreeTierLimit(raw: Record<string, unknown> | null, peerId: string | null = null): FreeTierLimit | null {
  if (!raw) return null;
  // A body the buyer already rewrote carries the limit under `free_tier`.
  const nested = raw.free_tier;
  const body = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : raw;
  const limitedBy = body.limitedBy === 'ip' || body.limitedBy === 'stake' || body.limitedBy === 'stake_required'
    ? body.limitedBy
    : 'address';
  return {
    peerId: peerId ?? (typeof body.peerId === 'string' ? body.peerId : null),
    limitedBy,
    limit: finiteNonNegative(body.limit),
    windowMs: finiteNonNegative(body.windowMs),
    retryAfterSeconds: finiteNonNegative(body.retryAfterSeconds),
    stakeTiers: readStakeTiers(body.stakeTiers),
    stakePower: finiteNonNegative(body.stakePower) ?? 0,
    baseLimit: finiteNonNegative(body.baseLimit),
    stakersOnly: body.stakersOnly === true || limitedBy === 'stake_required',
  };
}

/** The first tier above `power`, or null when the buyer already holds the top tier. */
export function nextFreeTierStakeTier(limit: Pick<FreeTierLimit, 'stakeTiers' | 'stakePower'>): FreeTierLimitStakeTier | null {
  return limit.stakeTiers.find((tier) => tier.minPower > limit.stakePower) ?? null;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

function formatWindow(windowMs: number): string {
  const hours = windowMs / 3_600_000;
  if (hours === 24) return 'per day';
  if (hours >= 1 && Number.isInteger(hours)) return `per ${hours} h`;
  return `per ${Math.max(1, Math.round(windowMs / 60_000))} min`;
}

/** What a tier allows: "5,000 free requests per day" when the base is known, else "5× the free limit". */
function formatTierAllowance(tier: FreeTierLimitStakeTier, limit: FreeTierLimit): string {
  if (tier.multiplier === 'unlimited') return 'unlimited free use';
  if (limit.baseLimit !== null && limit.windowMs !== null) {
    return `${formatCount(limit.baseLimit * tier.multiplier)} free requests ${formatWindow(limit.windowMs)}`;
  }
  return `${tier.multiplier}× the free limit`;
}

/** One plain sentence set for a free-tier limit, written by the buyer from the seller's numbers. */
export function describeFreeTierLimit(limit: FreeTierLimit): string {
  const scope = limit.limitedBy === 'ip' ? ' for your IP address' : '';
  const size = limit.limit !== null && limit.windowMs !== null
    ? ` (${formatCount(limit.limit)} requests ${formatWindow(limit.windowMs)})`
    : '';
  const next = nextFreeTierStakeTier(limit);
  if (limit.limitedBy === 'stake_required') {
    const unlock = next
      ? ` Stake ANTS in its pool to use it: ${formatCount(Math.ceil(next.minPower / EPOCHS_PER_YEAR))} ANTS locked for a year gives ${formatTierAllowance(next, limit)}.`
      : '';
    return `This model is free only for buyers staked on this seller.${unlock}`;
  }
  const reached = limit.limitedBy === 'stake'
    ? `Your staked free allowance on this seller is used up${size}.`
    : `Free limit reached on this seller${scope}${size}.`;
  const resets = limit.retryAfterSeconds !== null ? ` It resets in ${formatWait(limit.retryAfterSeconds)}.` : '';
  const stake = next
    ? ` Stake ANTS in this seller's pool to raise it: ${formatCount(Math.ceil(next.minPower / EPOCHS_PER_YEAR))} ANTS locked for a year gives ${formatTierAllowance(next, limit)}.`
    : '';
  return `${reached}${resets}${stake}`;
}

/** Whether `response` is a seller's free-tier refusal (429 `free_tier_exhausted`). */
export function isFreeTierExhaustedResponse(response: SerializedHttpResponse): boolean {
  return response.statusCode === 429 && parsePeerError(response).id === FREE_TIER_EXHAUSTED_ERROR_ID;
}

function parsePeerError(response: SerializedHttpResponse): PeerErrorDetails {
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
  } catch {
    // Plain-text seller failures are handled below.
  }

  const nested = body?.error;
  const error = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : null;
  const idCandidate = [error?.code, error?.type, body?.code, body?.type, body?.error]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const messageCandidate = [error?.peer_message, error?.message, body?.message, body?.error]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);

  let message = messageCandidate?.trim() ?? null;
  // Some upstreams (e.g. Venice) explain a 400 only in `details`, keyed by field.
  const detail = describeErrorDetails(body?.details ?? error?.details);
  if (detail && !message?.includes(detail)) message = message ? `${message}: ${detail}` : detail;
  if (!message && responseHeader(response, 'content-type')?.toLowerCase().includes('text/plain')) {
    message = new TextDecoder().decode(response.body).trim() || null;
  }

  return {
    body,
    error,
    id: idCandidate?.trim() ?? null,
    message: message?.slice(0, 1_000) ?? null,
  };
}

const MAX_DETAIL_ISSUES = 10;

/**
 * Flattens a validation `details` payload into "field: problem" text. Handles
 * zod-style `{ _errors: [...], field: { _errors: [...] } }` trees and falls
 * back to compact JSON for any other shape.
 */
function describeErrorDetails(details: unknown): string | null {
  if (typeof details === 'string') return details.trim() || null;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const issues: string[] = [];
  const visit = (node: unknown, path: string[]) => {
    if (issues.length >= MAX_DETAIL_ISSUES || !node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '_errors' && Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && item.trim() && issues.length < MAX_DETAIL_ISSUES) {
            issues.push(path.length ? `${path.join('.')}: ${item.trim()}` : item.trim());
          }
        }
      } else {
        visit(value, [...path, key]);
      }
    }
  };
  visit(details, []);
  if (issues.length) return issues.join('; ');
  const json = JSON.stringify(details);
  return json === '{}' || json === '{"_errors":[]}' ? null : json;
}

function isUserActionablePeerError(response: SerializedHttpResponse, errorId: string | null): boolean {
  if (response.statusCode === 413 || response.statusCode === 422) return true;
  return errorId !== null && USER_ACTIONABLE_PEER_ERROR_IDS.has(errorId.toLowerCase());
}

/**
 * Converts seller failures into a protocol-native peer error while preserving
 * trusted buyer faults, payment control messages, and actionable request errors.
 */
export function adaptPeerFaultErrorResponse(
  response: SerializedHttpResponse,
  requestProtocol: ServiceApiProtocol | null,
  options?: AdaptPeerFaultErrorOptions,
): SerializedHttpResponse {
  if (
    response.statusCode < 400
    || requestProtocol === null
    || responseHeader(response, ANTSEED_FAULT_ATTRIBUTION_HEADER)?.toLowerCase() === 'buyer'
  ) {
    return response;
  }

  const details = parsePeerError(response);
  const paymentRequired = response.statusCode === 402
    && (details.body?.error === 'payment_required' || details.error?.type === 'payment_required');
  if (paymentRequired) return response;

  const headers = {
    ...response.headers,
    [ANTSEED_FAULT_ATTRIBUTION_HEADER]: 'peer',
  };
  if (response.statusCode === 429 && details.id === FREE_TIER_EXHAUSTED_ERROR_ID) {
    // Rewritten from the seller's numbers only, so clients can show the
    // message and link to this seller's pool without trusting seller prose.
    const limit = readFreeTierLimit(details.body, options?.peerId)!;
    const error = {
      type: 'rate_limit_error',
      code: FREE_TIER_EXHAUSTED_ERROR_ID,
      message: describeFreeTierLimit(limit),
      antseed_fault: 'peer',
      antseed_pinned: options?.pinned === true,
      peer_status: 429,
    };
    // OpenAI-style clients keep only `error`; agent SDKs append `error.metadata.raw`
    // to the message (as for OpenRouter), so the limit survives into the error text.
    const raw = JSON.stringify({ error, free_tier: limit });
    const body = requestProtocol === 'anthropic-messages'
      ? { type: 'error', error, free_tier: limit }
      : { error: { ...error, metadata: { raw } }, free_tier: limit };
    return {
      ...response,
      headers: { ...headers, 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(body)),
    };
  }
  if (isUserActionablePeerError(response, details.id)) {
    return { ...response, headers };
  }

  const pinned = options?.pinned === true;
  const alreadyWrapped = details.error?.antseed_fault === 'peer';
  const alreadyPinned = details.error?.antseed_pinned === true;
  if (alreadyWrapped && (!pinned || alreadyPinned)) return { ...response, headers };

  const peerLabel = pinned ? 'pinned peer' : 'peer';
  const originalMessage = details.message ?? 'No additional details were provided.';
  const message = [
    `Oops, ${peerLabel} could not complete the request.`,
    'Antseed is a peer-to-peer network. Try another peer or use Auto routing.',
    `Original Response: ${JSON.stringify({ message: originalMessage, status: response.statusCode })}`,
  ].join('\n');
  const error = {
    ...(details.error ?? {}),
    type: typeof details.error?.type === 'string' ? details.error.type : details.id ?? 'upstream_error',
    message,
    antseed_fault: 'peer',
    antseed_pinned: pinned,
    peer_message: originalMessage,
    peer_status: response.statusCode,
  };
  const body = requestProtocol === 'anthropic-messages'
    ? { type: 'error', error }
    : { error };

  return {
    ...response,
    headers: { ...headers, 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}
