// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the sandbox network.
import { GATES, stressRun, stressTopology } from '../lib/stress.mjs';

export const meta = {
  description: 'Payment stress smoke (the quick shape of the stress CI): 6 paid requests, 2 at a time, through Base-like RPCs; the mock-judged payment oracle and crash checks must pass.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = stressTopology();

export async function run(sb) {
  await stressRun(sb, {
    load: { concurrency: 2, requests: 6 },
    gate: GATES.default,
  });
}
