// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the testbench network.
import { GATES, stressRun, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: '32 concurrent requests, 30% of them unit-billed image generations; images are paid per image and the oracle balances (stress images).',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

// Budgets: twice what one cli-mode `--chain local` run measured on a developer laptop (2026-11-07). Local-machine
// numbers; the nightly job will set CI numbers. Checked only with --budgets.
export const topology = stressTopology({ budgets: { p95Ms: 12554, loadMs: 48290, closeAllMs: 8694 } });

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 32, requests: 256, imageRatio: 0.3 },
    gate: GATES.default,
  });
}
