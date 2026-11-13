import { GATES, stressRun, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: '64 concurrent requests on a 0.25 USDC reserve with 12 s blocks: spend outruns each top-up, so the seller sits at the reserve ceiling while the next top-up is still mining. It must wait or answer a retryable 503 top_up_pending, never close a channel that is being extended, and the oracle must find every delivered response paid (stress slow-topups).',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

// A top-up raises the ceiling by at most 2.5 USDC (10 x the reserve) and takes a block to land; at this load about
// 6 USDC is spent per block, so the ceiling cannot keep ahead. Two blocks are longer than the seller's 15 s wait.
export const BLOCK_TIME_SEC = 12;

export const topology = stressTopology({ buyer: { maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15' }, chain: { blockTimeSec: BLOCK_TIME_SEC } });

/** How often a run sat at the ceiling with a top-up mining: the seller's two log lines for it, and the 503 the client saw. */
export function ceilingWaits({ run, logPatterns }) {
  return {
    stillAtCeiling: logPatterns.seller.stillAtCeiling ?? 0,
    topUpPendingAtBudget: logPatterns.seller.topUpPendingAtBudget ?? 0,
    clientTopUpPending: Object.entries(run.client.failures).filter(([kind]) => /top_up_pending/.test(kind)).reduce((sum, [, count]) => sum + count, 0),
  };
}

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 64, requests: 320 },
    gate: GATES['slow-topups'],
    // A top-up still mining when the load ends needs a block to land, and the payment that waited for it another moment.
    quiesceMs: 3 * BLOCK_TIME_SEC * 1000,
    evidence: (seen) => {
      const waits = ceilingWaits(seen);
      const topUps = seen.logPatterns.seller.topUpVerified;
      return [
        { name: 'fault path ran: top-ups chained under load', ok: topUps >= 2, detail: { topUpVerified: topUps } },
        { name: 'fault path ran: the seller was at the ceiling with a top-up still mining', ok: Object.values(waits).some((count) => count > 0), detail: waits },
      ];
    },
  });
}
