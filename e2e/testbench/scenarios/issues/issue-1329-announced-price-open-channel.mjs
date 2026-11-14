// #1329: the same offer as issue-1329-announced-price-first-request, used on a channel a normally priced service
// opened first. The seller sends no 402 there: it serves the request and asks for its cost afterwards.
import { build } from './issue-1329-announced-price-first-request.mjs';

export const { meta, topology, run } = build('open-channel');
