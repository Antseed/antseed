// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the testbench network.
import { GATES, stressRun, stressTopology } from '../lib/stress.mjs';

export const meta = {
  description: '32 concurrent requests, 30% of them unit-billed image generations; images are paid per image and the oracle balances (stress images).',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = stressTopology();

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 32, requests: 256, imageRatio: 0.3 },
    gate: GATES.default,
  });
}
