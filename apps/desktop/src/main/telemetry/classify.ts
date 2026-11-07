import type {
  ChatFailureReasonCode,
  ChatFailureCode,
  ChatFailureStage,
  DepositFailureCode,
  DepositFailureStage,
  DiscoveryFailureCode,
} from './events.js';

export function classifyDiscoveryFailure(error: string): DiscoveryFailureCode {
  const normalized = error.toLowerCase();
  if (/timed? ?out|timeout|abort/.test(normalized)) return 'timeout';
  if (/json|parse|invalid|malformed|unexpected token/.test(normalized)) return 'invalid_data';
  if (/enoent|eacces|eperm|file|directory|read/.test(normalized)) return 'io_error';
  return 'unknown';
}

export type NormalizedDepositFailure = {
  failureCode: DepositFailureCode;
  failureStage: DepositFailureStage;
  retryable: boolean;
};

export function classifyDepositFailure(error: string, watcherReason?: string | null): NormalizedDepositFailure {
  if (watcherReason === 'payments-disabled') {
    return { failureCode: 'payments_disabled', failureStage: 'preflight', retryable: false };
  }
  if (watcherReason === 'no-deposit-relay') {
    return { failureCode: 'deposit_relay_unavailable', failureStage: 'preflight', retryable: false };
  }

  const normalized = error.toLowerCase();
  if (/domain mismatch|eip-712/.test(normalized)) {
    return { failureCode: 'domain_mismatch', failureStage: 'signing', retryable: false };
  }
  if (/no deposit relayers? (?:are )?reachable|relayer.*unreachable/.test(normalized)) {
    return { failureCode: 'relayer_unreachable', failureStage: 'dispatch', retryable: true };
  }
  if (/no deposit relayer accepted|relayer.*declined/.test(normalized)) {
    return { failureCode: 'relayer_declined', failureStage: 'dispatch', retryable: true };
  }
  if (/not confirmed in time|confirmation.*timed? ?out/.test(normalized)) {
    return { failureCode: 'confirmation_timeout', failureStage: 'confirmation', retryable: true };
  }
  if (/\brpc\b|failed to fetch|network error|connection (?:refused|reset)|enotfound|ehostunreach/.test(normalized)) {
    return { failureCode: 'rpc_unavailable', failureStage: 'preflight', retryable: true };
  }
  if (watcherReason !== undefined) {
    return { failureCode: 'watcher_unavailable', failureStage: 'preflight', retryable: true };
  }
  return { failureCode: 'unknown', failureStage: 'sweep', retryable: true };
}

export type ChatFailureReason = {
  kind: string;
  source: string;
  retryable: boolean;
  statusCode?: number;
};

export type NormalizedChatFailure = {
  failureCode: ChatFailureCode;
  failureStage: ChatFailureStage;
  retryable: boolean;
  statusCode?: number;
};

function inferStreamedHttpStatus(rawMessage: string): number | undefined {
  const match = /(?:^|:\s)([45]\d{2})\s+data:\s*\{/i.exec(rawMessage)
    // SDK-prefixed bodies: "402 You are out of…", "502 {json}". Requires a
    // JSON body or a capitalised sentence so "429 requests remaining" is not
    // read as a status.
    ?? /^\s*([45]\d{2})\s+(?=[{A-Z])/.exec(rawMessage);
  if (!match) return undefined;
  const statusCode = Number(match[1]);
  return Number.isFinite(statusCode) ? statusCode : undefined;
}

/** Exact HTTP status of a failure, from the stop reason or the raw message. */
export function chatFailureHttpStatus(reason: ChatFailureReason, rawMessage = ''): number | undefined {
  return reason.statusCode ?? inferStreamedHttpStatus(rawMessage);
}

export function classifyChatRequestFailure(
  reason: ChatFailureReason,
  rawMessage = '',
): NormalizedChatFailure {
  const normalized = rawMessage.toLowerCase();
  const statusCode = reason.statusCode ?? inferStreamedHttpStatus(rawMessage);
  if (/model_not_found|not served by this peer|model .* not (?:served|available)/.test(normalized)) {
    return {
      failureCode: 'model_not_served_by_peer',
      failureStage: 'request_validation',
      retryable: true,
      ...(statusCode ? { statusCode } : {}),
    };
  }
  if (reason.kind === 'payment_required' || statusCode === 402) {
    return {
      failureCode: 'payment_required',
      failureStage: 'payment',
      retryable: false,
      statusCode: statusCode ?? 402,
    };
  }
  if (reason.kind === 'aborted') {
    return { failureCode: 'user_aborted', failureStage: 'user', retryable: false };
  }
  if (reason.kind === 'timeout') {
    return { failureCode: 'timeout', failureStage: 'transport', retryable: true };
  }
  if (statusCode === 429) {
    return { failureCode: 'rate_limited', failureStage: 'upstream', retryable: true, statusCode };
  }
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return { failureCode: 'http_4xx', failureStage: 'upstream', retryable: reason.retryable, statusCode };
  }
  if (typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600) {
    return { failureCode: 'http_5xx', failureStage: reason.source === 'transport' ? 'transport' : 'upstream', retryable: reason.retryable, statusCode };
  }
  if (reason.kind === 'network_error') {
    return { failureCode: 'network_error', failureStage: 'transport', retryable: reason.retryable };
  }
  if (reason.kind === 'stream_error') {
    return { failureCode: 'stream_error', failureStage: 'streaming', retryable: reason.retryable };
  }
  return {
    failureCode: 'unknown',
    failureStage: reason.source === 'transport' ? 'transport' : 'upstream',
    retryable: reason.retryable,
  };
}

export type ChatFailureReasonContext = {
  /** Whether any text/tool output streamed before the failure. */
  hadPartialOutput: boolean;
  /** Whether the buyer had discovered any online peer when the request was sent. */
  peersDiscoveredAtSend: boolean;
  /** Distinct known sellers / free sellers for the requested model at send. */
  sellersKnown: number;
  freeSellersKnown: number;
  /** Undefined when the balance has not been read yet. */
  buyerBalanceZero?: boolean;
};

const BUYER_SIDE_FAULT = /antseed_buyer_fault|buyer_request_failed|buyer_payments_inactive|payments_inactive|payment_negotiation_failed/i;
const PAYMENT_SIGNAL = /payment_required|insufficient_deposits|out of antseed credits/i;
const NO_SELLER_SIGNAL = /model_not_found|no policy-allowed peer|not served by this peer|model .* not (?:served|available)|no verified peer currently serves/i;
const NO_PEERS_SIGNAL = /no peers discovered/i;
const UNREACHABLE_SIGNAL = /\bis not reachable\b|p2p request failed|connection to \S+ failed|\bpeer unreachable\b|ehostunreach|econnrefused/i;
const TIMEOUT_SIGNAL = /\btimed out\b|\btimeout\b/i;

/**
 * Collapse a failed chat request into the fixed `failure_reason` taxonomy.
 * Only the returned enum leaves the device; `rawMessage` is read here and
 * discarded.
 *
 * - `out_of_credits` / `model_needs_paid`: a 402 or payment-required body.
 *   `model_needs_paid` when the buyer's balance is zero and no free seller
 *   serves the model, so funding is the only way to use it.
 * - `no_seller_yet`: no seller for the model and no peers were discovered at
 *   send (still starting up); `no_seller_available` once peers were known.
 * - `seller_dropped_before_output` / `seller_dropped_mid_answer`: a stream or
 *   connection that ended without an HTTP status, split by partial output.
 */
export function classifyChatFailureReason(
  reason: ChatFailureReason,
  rawMessage: string,
  context: ChatFailureReasonContext,
): ChatFailureReasonCode {
  if (reason.kind === 'aborted') return 'none';
  const statusCode = chatFailureHttpStatus(reason, rawMessage);
  if (reason.kind === 'payment_required' || statusCode === 402 || PAYMENT_SIGNAL.test(rawMessage)) {
    return context.buyerBalanceZero === true && context.freeSellersKnown === 0
      ? 'model_needs_paid'
      : 'out_of_credits';
  }
  if (BUYER_SIDE_FAULT.test(rawMessage)) return 'local_error';
  if (NO_SELLER_SIGNAL.test(rawMessage) || NO_PEERS_SIGNAL.test(rawMessage)) {
    return context.peersDiscoveredAtSend && !NO_PEERS_SIGNAL.test(rawMessage)
      ? 'no_seller_available'
      : 'no_seller_yet';
  }
  if (reason.kind === 'timeout' || statusCode === 408 || statusCode === 504 || TIMEOUT_SIGNAL.test(rawMessage)) {
    return 'timeout';
  }
  if (statusCode === 429) return 'rate_limited';
  if (UNREACHABLE_SIGNAL.test(rawMessage)) return 'seller_unreachable';
  if (typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600) return 'seller_5xx';
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) return 'request_rejected';
  if (reason.kind === 'network_error' || reason.kind === 'stream_error' || reason.kind === 'unknown') {
    return context.hadPartialOutput ? 'seller_dropped_mid_answer' : 'seller_dropped_before_output';
  }
  return 'unknown';
}
