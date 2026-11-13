// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the testbench network.
import { GATES, stressRun, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: '32 concurrent requests with the seller restarted 40% of the way through; no failures outside the restart window, the seller stops without SIGKILL, and the oracle balances (stress restart-seller).',
  targets: ['local', 'fork'],
  requires: ['sellerControl', 'mockControl'],
};

// Budgets: twice what one cli-mode `--chain local` run measured on a developer laptop (2026-11-07). Local-machine
// numbers; the nightly job will set CI numbers. Checked only with --budgets.
export const topology = stressTopology({ budgets: { p95Ms: 13928, loadMs: 58396, closeAllMs: 14176, restartDownMs: 10186 } });

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 32, requests: 300, restart: { who: 'seller', atFraction: 0.4 } },
    gate: GATES['restart-seller'],
  });
}
