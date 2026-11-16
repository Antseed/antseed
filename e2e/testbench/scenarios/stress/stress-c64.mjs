// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the testbench network.
import { GATES, stressRun, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: '64 concurrent paid requests (384, half streamed) through Base-like RPCs; at least 99% succeed and the payment oracle finds delivered work paid exactly (stress c64).',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = stressTopology();

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 64, requests: 384 },
    gate: GATES.default,
  });
}
