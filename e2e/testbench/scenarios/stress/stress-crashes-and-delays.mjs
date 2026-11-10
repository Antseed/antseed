import { crashesAndDelays, crashesAndDelaysPlan, crashesAndDelaysTopology } from '../../lib/crashes-and-delays.mjs';

export const meta = {
  description: 'Crashes and delays on the seller, on a 0.25 USDC reserve: every point the payment path reaches under load is armed at once (store writes, the reserve and top-up transactions, the NeedAuth, SpendingAuth and top-up steps), each with a seeded chance to kill the seller (SIGKILL) there, and the points that can wait delay a share of their hits. There is no cap on the crashes: a killed seller stays down for a drawn time, and nothing is killed in the drawn grace window after its restart. 480 requests run 16-way around the crashes; the settle and close points then stay armed through the idle settle and the close. At least one crash must fire and each must be followed by a restart, nothing may fail outside the restart windows, the ok share is held to the number of crashes that fired, and the oracle judges the money (stress crashes-and-delays). Run it across seeds.',
  targets: ['local', 'fork'],
  requires: ['sellerControl', 'mockControl', 'failpoints'],
};

export const topology = crashesAndDelaysTopology();

const NODES = ['seller'];

/** What this scenario arms for a run seed, without a testbench (`pnpm testbench plan`). */
export const failpointPlan = (seed) => crashesAndDelaysPlan(seed, { nodes: NODES });

export async function run(tb) {
  await crashesAndDelays(tb, { nodes: NODES });
}
