// Ported from the payment stress harness (e2e/stress/scenarios.mjs, gates from e2e/stress/ci.mjs) onto the testbench network.
import { GATES, stressRun, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: '32 concurrent requests on a 0.25 USDC reserve; the seller\'s RPC link holds its first topUp() transaction and the seller restarts 3 s later, so a verified top-up never reaches the chain while work above the deposit is being served. The restarted seller must resubmit it: the oracle balances, no failures outside the restart window (stress restart-seller-topup).',
  targets: ['local', 'fork'],
  requires: ['sellerControl', 'mockControl'],
};

export const topology = stressTopology({ buyer: { maxReserveUsdc: '0.25', maxPerRequestUsdc: '0.15' } });

export async function run(tb) {
  await stressRun(tb, {
    load: { concurrency: 32, requests: 384, restart: { who: 'seller', on: 'top-up', settleMs: 3000 } },
    gate: GATES['restart-seller-topup'],
  });
}
