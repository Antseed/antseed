// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the testbench network.
import { GATES, stressRun, stressTopology } from '../lib/stress.mjs';

export const meta = {
  description: '32 concurrent requests with upstream 500s (5%), mid-response disconnects (5%) and client aborts (10%); only injected failures may fail, and the buyer pays for no more than reached the wire (stress faults).',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = stressTopology();

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 32, requests: 256, abortRatio: 0.1 },
    faults: { fault500Rate: 0.05, disconnectRate: 0.05 },
    gate: GATES.faults,
  });
}
