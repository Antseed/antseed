// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the sandbox network.
import { GATES, stressRun, stressTopology } from '../lib/stress.mjs';

export const meta = {
  description: '32 concurrent paid requests (256, half streamed) through Base-like RPCs; at least 99% succeed and the payment oracle finds delivered work paid exactly (stress c32).',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = stressTopology();

export async function run(sb) {
  await stressRun(sb, {
    load: { concurrency: 32, requests: 256 },
    gate: GATES.default,
  });
}
