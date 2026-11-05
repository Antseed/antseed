// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the testbench network.
import { GATES, stressRun, stressTopology } from '../lib/stress.mjs';

export const meta = {
  description: '32 concurrent paid requests with a 0.25 USDC reserve and 0.15 USDC per-request cap, so channels top up and rotate under load; the payment oracle must still balance (stress smallreserve).',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = stressTopology({ buyer: { maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15' } });

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 32, requests: 256 },
    gate: GATES.default,
  });
}
