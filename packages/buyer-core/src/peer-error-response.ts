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
