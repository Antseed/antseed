/**
 * Fixed `failure_reason` taxonomy for a model request, shared by the desktop
 * chat (what the user saw) and the buyer proxy (what the network did). Raw
 * error text is read here and discarded; only the enum leaves the device.
 */

export type FailureReason =
  | 'none'
  | 'out_of_credits'
  | 'model_needs_paid'
  | 'seller_dropped_before_output'
  | 'seller_dropped_mid_answer'
  | 'seller_5xx'
  | 'request_rejected'
  | 'rate_limited'
  | 'no_seller_available'
  | 'no_seller_yet'
  | 'seller_unreachable'
  | 'timeout'
  | 'local_error'
  | 'unknown';

export const FAILURE_REASONS: ReadonlySet<string> = new Set<FailureReason>([
  'none',
  'out_of_credits',
  'model_needs_paid',
  'seller_dropped_before_output',
  'seller_dropped_mid_answer',
  'seller_5xx',
  'request_rejected',
  'rate_limited',
  'no_seller_available',
  'no_seller_yet',
  'seller_unreachable',
  'timeout',
  'local_error',
  'unknown',
]);

/** A classified stop: the kind of failure, and its HTTP status when known. */
export type FailureSignal = {
  kind: string;
  statusCode?: number;
};

export type FailureReasonContext = {
  /** Whether any text/tool output reached the client before the failure. */
  hadPartialOutput: boolean;
  /** Whether any online peer was known when the request was sent. */
  peersDiscoveredAtSend: boolean;
  /** Distinct free sellers known for the model at send. */
  freeSellersKnown: number;
  /** Undefined when the balance is unknown. */
  buyerBalanceZero?: boolean;
};

const BUYER_SIDE_FAULT = /antseed_buyer_fault|buyer_request_failed|buyer_payments_inactive|payments_inactive|payment_negotiation_failed/i;
const PAYMENT_SIGNAL = /payment_required|insufficient_deposits|out of antseed credits/i;
const NO_SELLER_SIGNAL = /model_not_found|no policy-allowed peer|not served by this peer|model .* not (?:served|available)|no verified peer currently serves|no sellers available/i;
const NO_PEERS_SIGNAL = /no peers discovered|no sellers available on the network/i;
const UNREACHABLE_SIGNAL = /\bis not reachable\b|p2p request failed|connection to \S+ failed|\bpeer unreachable\b|ehostunreach|econnrefused/i;
const TIMEOUT_SIGNAL = /\btimed out\b|\btimeout\b|no answer within/i;

/**
 * The status an SDK puts in front of an error body: "402 You are out of…",
 * "502 Pinned peer …", "503 {json}", or a streamed "… 400 data: {". Prose such
 * as "429 requests remaining" is not read as a status.
 */
export function leadingHttpStatus(rawMessage: string): number | undefined {
  const match = /(?:^|:\s)([45]\d{2})\s+data:\s*\{/i.exec(rawMessage)
    ?? /^\s*([45]\d{2})\s+(?=[{A-Z])/.exec(rawMessage);
  if (!match) return undefined;
  const statusCode = Number(match[1]);
  return Number.isFinite(statusCode) ? statusCode : undefined;
}

export function failureHttpStatus(signal: FailureSignal, rawMessage = ''): number | undefined {
  return signal.statusCode ?? leadingHttpStatus(rawMessage);
}

/**
 * Collapse a failed request into the fixed taxonomy.
 *
 * - `out_of_credits` / `model_needs_paid`: a 402 or payment-required body;
 *   `model_needs_paid` when the balance is zero and no free seller serves
 *   the model, so funding is the only way to use it.
 * - `no_seller_yet`: no seller and no peers were known at send (still
 *   starting up); `no_seller_available` once peers were known.
 * - `seller_dropped_*`: a stream or connection that ended without a status,
 *   split by whether output had started.
 */
export function classifyFailureReason(
  signal: FailureSignal,
  rawMessage: string,
  context: FailureReasonContext,
): FailureReason {
  if (signal.kind === 'aborted') return 'none';
  const statusCode = failureHttpStatus(signal, rawMessage);
  if (signal.kind === 'payment_required' || statusCode === 402 || PAYMENT_SIGNAL.test(rawMessage)) {
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
  if (signal.kind === 'timeout' || statusCode === 408 || statusCode === 504 || TIMEOUT_SIGNAL.test(rawMessage)) {
    return 'timeout';
  }
  if (statusCode === 429) return 'rate_limited';
  if (UNREACHABLE_SIGNAL.test(rawMessage)) return 'seller_unreachable';
  if (typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600) return 'seller_5xx';
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) return 'request_rejected';
  if (signal.kind === 'network_error' || signal.kind === 'stream_error' || signal.kind === 'unknown') {
    return context.hadPartialOutput ? 'seller_dropped_mid_answer' : 'seller_dropped_before_output';
  }
  return 'unknown';
}
