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

/** A relayed request the buyer sent whose answer did not end: it timed out, was given up, or its stream broke. */
export interface InterruptedRelayedResponse {
  requestId: string;
  service: string;
  /** The body the buyer sent: the seller checked its length. */
  requestBody: Uint8Array;
  /** How much of the raw answer reached the buyer: 0 for none, or for a request only just sent. */
  receivedLength: number;
  /** The output limit the request ended with, as the seller checked it: null for none. */
  maxOutputTokens: number | null;
}

/**
 * Buyer side: keeps a record of a relayed request from the moment it is sent,
 * and prices one whose answer did not end. The seller bills what it relayed of
 * such an answer as it bills any answer it is shown no usage of
 * (`keyedRelayUnrevealedUsage`), so the buyer prices what reached it the same
 * way: that charge is then signed, and the seller admits the next request.
 * The seller cannot see the answer's status, so the buyer does not go by it
 * either. The record is a cut-off one, paid only when the seller claims it.
 * With no byte of an answer nothing is priced: a charge for it is signed only
 * inside the overdraft window, like any claim the buyer cannot check.
 */
export function recordInterruptedRelayedCost(
  negotiator: BuyerPaymentNegotiator,
  peer: PeerInfo,
  interrupted: InterruptedRelayedResponse,
): void {
  const { requestId, service, requestBody, receivedLength, maxOutputTokens } = interrupted;
  negotiator.bpm.trackRequestService(requestId, service);
  negotiator.bpm.recordDeliveredResponse(peer.peerId, requestId, { costUsdc: 0n, cutOff: true });
  if (receivedLength <= 0) return;
  negotiator.estimateCostFromPartialResponse(
    peer,
    { requestId, body: requestBody },
    { requestId, statusCode: 200, headers: {}, body: new Uint8Array(0) },
    service,
    keyedRelayUnrevealedUsage(keyedRequestInputTokens(requestBody.length), receivedLength, maxOutputTokens),
  );
}
