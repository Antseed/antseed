// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the testbench network.
import { GATES, stressRun, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: '32 concurrent requests with the buyer restarted 40% of the way through; no failures outside the restart window and the oracle balances across the old and new channels (stress restart-buyer).',
  targets: ['local', 'fork'],
  requires: ['buyerControl', 'mockControl'],
};

// Budgets: twice what one cli-mode `--chain local` run measured on a developer laptop (2026-11-07). Local-machine
// numbers; the nightly job will set CI numbers. Checked only with --budgets.
export const topology = stressTopology({ budgets: { p95Ms: 18566, loadMs: 178658, closeAllMs: 8452, restartDownMs: 110054, settleOnDisconnectMs: 20132 } });

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 32, requests: 300, restart: { who: 'buyer', atFraction: 0.4 } },
    gate: GATES['restart-buyer'],
  });
}
