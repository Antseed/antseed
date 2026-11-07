// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the testbench network.
import { GATES, stressRun, stressTopology } from '../lib/stress.mjs';

export const meta = {
  description: 'Payment stress smoke (the quick shape of the stress CI): 6 paid requests, 2 at a time, through Base-like RPCs; the mock-judged payment oracle and crash checks must pass.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

// Budgets: twice what one cli-mode `--chain local` run measured on a developer laptop (2026-11-07). Local-machine
// numbers; the nightly job will set CI numbers. Checked only with --budgets.
export const topology = stressTopology({ budgets: { p95Ms: 5730, loadMs: 10172, closeAllMs: 17476 } });

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 2, requests: 6 },
    gate: GATES.default,
  });
}
