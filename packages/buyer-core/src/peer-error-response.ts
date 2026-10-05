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
  const messageCandidate = [error?.peer_message, error?.message, body?.message]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);

  let message = messageCandidate?.trim() ?? null;
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
