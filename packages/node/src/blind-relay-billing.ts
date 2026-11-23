import { keyedRelayUnrevealedUsage, readKeyedRelayReveal, type KeyedRelayReveal } from './keyed-relay-billing.js';
import { keyedRequestInputTokens } from './keyed-relay-request.js';
import type { BuyerPaymentNegotiator } from './payments/buyer-payment-negotiator.js';
import type { SerializedHttpResponse } from './types/http.js';
import type { PeerInfo } from './types/peer.js';
import type { ResponseUsage } from './utils/response-usage.js';

/** A request answered over the blind relay, as the buyer prices it. */
export interface RelayedResponse {
  requestId: string;
  service: string;
  /** The body the buyer sent: the seller checked its length. */
  requestBody: Uint8Array;
  response: SerializedHttpResponse;
  /** What the seller bills by: the length of the raw answer, and the ranges of it the buyer reveals. */
  revealed: KeyedRelayReveal;
  /** The output limit the request ended with, as the seller checked it: null for none. */
  maxOutputTokens: number | null;
}

/**
 * The usage the seller bills a relayed answer by when the buyer's reveal shows
 * it none (`SellerBlindRelay`), from the three figures both sides hold: the
 * request body's length, the raw answer's length and the request's output
 * limit. Null when the reveal shows the usage, or no answer came.
 */
function unrevealedUsage(relayed: RelayedResponse): ResponseUsage | null {
  const { revealed } = relayed;
  if (revealed.length <= 0 || readKeyedRelayReveal(revealed).usage) return null;
  return keyedRelayUnrevealedUsage(keyedRequestInputTokens(relayed.requestBody.length), revealed.length, relayed.maxOutputTokens);
}

/**
 * Buyer side: prices a request answered over the seller-blind relay by the
 * usage the seller will bill it by, at the seller's advertised token prices.
 * That is the usage the buyer read in the answer when its reveal shows it,
 * and otherwise the seller's own figure for an answer shown no usage
 * (`keyedRelayUnrevealedUsage`), which the buyer works out from its own
 * request and answer. The seller's charge for `requestId`, sent once the
 * buyer has revealed, is signed only up to this cost.
 */
export function recordRelayedCost(
  negotiator: BuyerPaymentNegotiator,
  peer: PeerInfo,
  relayed: RelayedResponse,
): void {
  negotiator.bpm.trackRequestService(relayed.requestId, relayed.service);
  negotiator.estimateCostFromResponse(peer, relayed.response, relayed.service, relayed.requestId, relayed.requestBody, unrevealedUsage(relayed) ?? undefined);
}
