import { crashesAndDelays, crashesAndDelaysPlan, crashesAndDelaysTopology } from '../../lib/crashes-and-delays.mjs';

export const meta = {
  description: 'Crashes and delays on both nodes, on a 0.25 USDC reserve: every point the seller and the buyer reach under load is armed at once, each node with its own seeded plan (the chance of a crash, a drawn time down, a drawn grace window, delays at the points that can wait) and no cap on the crashes. The two share one crash state: at most one of them is down at a time, and nothing is killed in the grace window after a restart. 480 requests run 16-way around the crashes; the seller\'s settle and close points then stay armed through the idle settle and the close. At least one crash must fire and each must be followed by a restart, nothing may fail outside the restart windows, the ok share is held to the number of crashes that fired, and the oracle judges the money (stress crashes-and-delays-both). Run it across seeds.',
  targets: ['local', 'fork'],
  requires: ['sellerControl', 'buyerControl', 'mockControl', 'failpoints'],
};

export const topology = crashesAndDelaysTopology();

const NODES = ['seller', 'buyer'];

/** What this scenario arms for a run seed, without a testbench (`pnpm testbench plan`). */
export const failpointPlan = (seed) => crashesAndDelaysPlan(seed, { nodes: NODES });

export async function run(tb) {
  await crashesAndDelays(tb, { nodes: NODES });
}
