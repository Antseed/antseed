import { GATES, stressRun, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: '16 concurrent requests with a 20 s buyer request timeout and an upstream that takes 40 s for 8% of them: the buyer gives up on those while the seller is still working, later requests must go through untouched, and the close must balance (stress buyer-timeout). cli mode only: `antseed buyer start` reads buyer.requestTimeoutMs.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

// The timeout is above the seller's 15 s top-up wait, so only the slow upstream trips it. It bounds a non-streamed
// request; a streamed one waits at least 90 s for its first byte (buyer-request-handler.ts), so it is only slow.
export const REQUEST_TIMEOUT_MS = 20_000;
export const SLOW_MS = 40_000;

export const topology = stressTopology({ buyer: { requestTimeoutMs: REQUEST_TIMEOUT_MS } });

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 16, requests: 160 },
    faults: { slowRate: 0.08, slowMs: SLOW_MS },
    gate: GATES['buyer-timeout'],
    followUp: { load: { concurrency: 8, requests: 48 }, gate: GATES.default },
    evidence: ({ logPatterns }) => [
      { name: 'fault path ran: the buyer timed requests out', ok: logPatterns.buyer.requestTimedOut > 0, detail: { requestTimedOut: logPatterns.buyer.requestTimedOut } },
    ],
  });
}
