// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the testbench network.
import { GATES, stressRun, stressTopology } from '../lib/stress.mjs';

export const meta = {
  description: '32 concurrent requests with upstream 500s (5%), mid-response disconnects (5%) and client aborts (10%); only injected failures may fail, and the buyer pays for no more than reached the wire (stress faults).',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

// Budgets: twice what one cli-mode `--chain local` run measured on a developer laptop (2026-11-07). Local-machine
// numbers; the nightly job will set CI numbers. Checked only with --budgets.
export const topology = stressTopology({ budgets: { p95Ms: 12066, loadMs: 46972, closeAllMs: 15450 } });

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 32, requests: 256, abortRatio: 0.1 },
    faults: { fault500Rate: 0.05, disconnectRate: 0.05 },
    gate: GATES.faults,
  });
}
