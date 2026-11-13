import { chaosGate, drawChaosPlan } from '../../lib/chaos.mjs';
import { stressRun, stressTopology } from '../../lib/stress.mjs';
import { ceilingWaits } from './stress-slow-topups.mjs';

export const meta = {
  description: 'One seeded fault plan per run on a 0.25 USDC reserve: the seed draws which of upstream 500s, disconnects, client aborts, chats without max_tokens, a slow upstream past the buyer timeout, slow blocks, and a seller restart, seller crash or buyer restart fire, and when. The plan is in the report (metrics.chaosPlan); every drawn fault must be seen firing, and the oracle judges the money (stress chaos). Run it across seeds.',
  targets: ['local', 'fork'],
  requires: ['sellerControl', 'buyerControl', 'mockControl'],
};

const BLOCK_TIME_SEC = 2;

export const topology = stressTopology({ buyer: { maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15', requestTimeoutMs: 20_000 }, chain: { blockTimeSec: BLOCK_TIME_SEC } });

export async function run(tb) {
  const plan = drawChaosPlan(tb.prng('chaos'));
  tb.metric('chaosPlan', plan);
  await tb.event('chaos-plan', plan);
  console.log(`[chaos] plan: ${plan.fired.join(', ')} ${JSON.stringify({ faults: plan.faults, load: plan.load, blockTimeSec: plan.blockTimeSec ?? BLOCK_TIME_SEC })}`);
  if (plan.blockTimeSec) await tb.setBlockTime(plan.blockTimeSec);
  try {
    await stressRun(tb, {
      load: plan.load,
      faults: plan.faults,
      gate: chaosGate(plan),
      evidence: (seen) => [
        ...(plan.faults.slowRate ? [{ name: 'fault path ran: the buyer timed requests out', ok: seen.logPatterns.buyer.requestTimedOut > 0, detail: { requestTimedOut: seen.logPatterns.buyer.requestTimedOut } }] : []),
        ...(plan.blockTimeSec ? [{ name: 'fault path ran: the channel topped up on slow blocks', ok: seen.logPatterns.seller.topUpVerified > 0, detail: { topUpVerified: seen.logPatterns.seller.topUpVerified, ...ceilingWaits(seen) } }] : []),
      ],
    });
  } finally {
    if (plan.blockTimeSec) await tb.setBlockTime(BLOCK_TIME_SEC);
  }
}
