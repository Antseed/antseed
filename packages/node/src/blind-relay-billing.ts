import type { BuyerPaymentNegotiator } from './payments/buyer-payment-negotiator.js';
import type { SerializedHttpResponse } from './types/http.js';
import type { PeerInfo } from './types/peer.js';

/**
 * Buyer side: prices a request answered over the seller-blind relay the way a
 * proxied response is priced, from the usage the buyer read itself and the
 * seller's advertised token prices. The seller's charge for `requestId`, sent
 * once the buyer has revealed the usage, is signed only up to this cost.
 */
export function recordRelayedCost(
  negotiator: BuyerPaymentNegotiator,
  peer: PeerInfo,
  relayed: { requestId: string; service: string; requestBody: Uint8Array; response: SerializedHttpResponse },
): void {
  negotiator.bpm.trackRequestService(relayed.requestId, relayed.service);
  negotiator.estimateCostFromResponse(peer, relayed.response, relayed.service, relayed.requestId, relayed.requestBody);
}
