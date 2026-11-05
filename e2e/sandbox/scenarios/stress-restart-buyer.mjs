// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the sandbox network.
import { GATES, stressRun, stressTopology } from '../lib/stress.mjs';

export const meta = {
  description: '32 concurrent requests with the buyer restarted 40% of the way through; no failures outside the restart window and the oracle balances across the old and new channels (stress restart-buyer).',
  targets: ['local', 'fork'],
  requires: ['buyerControl', 'mockControl'],
};

export const topology = stressTopology();

export async function run(sb) {
  await stressRun(sb, {
    load: { concurrency: 32, requests: 300, restart: { who: 'buyer', atFraction: 0.4 } },
    gate: GATES['restart-buyer'],
  });
}
