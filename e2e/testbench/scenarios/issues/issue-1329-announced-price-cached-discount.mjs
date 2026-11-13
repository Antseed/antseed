// #1329: an offer the buyer routes to, with cached input priced below input. The buyer and the seller must price
// every response the same, so the buyer signs exactly the seller's cost and the channel closes at it.
import { build } from './issue-1329-announced-price-first-request.mjs';

export const { meta, topology, run } = build('cached-discount');
