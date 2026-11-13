// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the testbench network.
import { GATES, stressRun, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: '8 concurrent paid requests (120, half streamed) through Base-like RPCs; at least 99% succeed and the payment oracle finds delivered work paid exactly (stress c8).',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

// Budgets: twice what one cli-mode `--chain local` run measured on a developer laptop (2026-11-08). Local-machine
// numbers; the nightly job will set CI numbers. Checked only with --budgets.
export const topology = stressTopology({ budgets: { p95Ms: 15904, loadMs: 99192, closeAllMs: 9748 } });

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 8, requests: 120 },
    gate: GATES.default,
  });
}
