import { describe, expect, it } from 'vitest';
import { analyzePayments } from '../stress/analysis.mjs';

const CHANNEL = '0x' + 'ab'.repeat(32);

/** One channel whose seller, buyer and chain all agree that `settled` was paid. */
function run(settled: bigint, delivered: Array<[tag: string, status: string, cost: bigint]>) {
  const row = { session_id: CHANNEL, role: 'seller', auth_max: settled.toString(), tokens_delivered: settled.toString(), status: 'settled', request_count: delivered.length };
  return analyzePayments({
    sellerRowsPre: [row],
    sellerRowsPost: [row],
    buyerRowsPost: [{ ...row, role: 'buyer' }],
    chain0: { buyerBalance: 1_000_000n, buyerReserved: 0n, sellerUsdc: 0n, reserveUsdc: 0n },
    chain1: { buyerBalance: 1_000_000n - settled, buyerReserved: 0n, sellerUsdc: settled, reserveUsdc: 0n },
    allIds: [CHANNEL],
    onchain: { [CHANNEL]: { settled, deposit: 1_000_000n, status: 2 } },
    mockStats: {
      expectedCostBaseUnits: delivered.filter(([, status]) => status === 'ok').reduce((sum, [, , cost]) => sum + cost, 0n),
      perRequest: new Map(delivered.map(([tag, status, cost]) => [tag, { status, cost: cost.toString() }])),
    },
    results: delivered.map(([tag, status]) => (status === 'ok' ? { tag } : { tag, error: '500:server_error' })),
    sc: { fault500Rate: 0.05, disconnectRate: 0, abortRatio: 0, restart: null },
  });
}

describe('stress harness payment analysis', () => {
  it('passes a faults run that paid for exactly what the upstream delivered', () => {
    expect(run(100n, [['a', 'ok', 100n], ['b', '500', 20n]]).violations).toEqual([]);
  });

  it('fails a charge for an upstream error, even when every ledger agrees with it', () => {
    const { violations } = run(120n, [['a', 'ok', 100n], ['b', '500', 20n]]);

    expect(violations.map((v: { kind: string }) => v.kind)).toEqual(['settled-above-upstream-delivery']);
  });

  it('fails a run that settled less than the responses the client received', () => {
    const { violations } = run(80n, [['a', 'ok', 100n]]);

    expect(violations.map((v: { kind: string }) => v.kind)).toEqual(['client-received-work-unpaid']);
  });
});
