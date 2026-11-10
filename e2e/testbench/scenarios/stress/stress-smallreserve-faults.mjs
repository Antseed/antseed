import { GATES, stressRun, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: '32 concurrent requests on a 0.25 USDC reserve with a 0.15 USDC per-request cap, with upstream 500s (5%), mid-response disconnects (5%), client aborts (10%) and 40% of chats sent without max_tokens: channels top up and rotate while requests fail under them, only injected failures may fail, and the buyer pays for no more than reached the wire (stress smallreserve-faults).',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = stressTopology({ buyer: { maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15' } });

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 32, requests: 256, abortRatio: 0.1, omitMaxTokensRatio: 0.4 },
    faults: { fault500Rate: 0.05, disconnectRate: 0.05 },
    gate: GATES.faults,
    // The point of the small reserve: the faults must land on a channel that is being extended.
    evidence: ({ logPatterns }) => [
      { name: 'fault path ran: the channel topped up under the faults', ok: logPatterns.seller.topUpVerified > 0, detail: { topUpVerified: logPatterns.seller.topUpVerified } },
    ],
  });
}
