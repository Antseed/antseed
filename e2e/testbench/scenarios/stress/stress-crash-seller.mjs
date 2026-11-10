import { GATES, stressRun, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: '32 concurrent requests with the seller killed (SIGKILL) 40% of the way through and started again: it gets no chance to settle or close, so the channels it left open must still settle what was delivered, with no failures outside the restart window (stress crash-seller).',
  targets: ['local', 'fork'],
  requires: ['sellerControl', 'mockControl'],
};

export const topology = stressTopology();

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 32, requests: 300, restart: { who: 'seller', atFraction: 0.4, crash: true } },
    gate: GATES['crash-seller'],
  });
}
