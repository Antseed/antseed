import { describe, expect, it } from 'vitest';
import { Interface } from 'ethers';
import { MULTICALL3_ADDRESS } from '@antseed/node/payments';
import { normalLockStarts, type LineageRow } from './lock-start.js';

const POOLS = '0x0000000000000000000000000000000000000001';
const UINT_MAX = 2n ** 256n - 1n;
const iface = new Interface([
  'function positionWithdrawableEpoch(uint256 positionId) view returns (uint64)',
  'function positionPowerSegmentAt(uint256 positionId, uint256 epoch) view returns (uint256 normalEndEpoch, uint256 maxLockPower, uint256 nextChangeEpoch)',
]);

/** A chain with the pool but no Multicall3, as a bare local Anvil chain. */
function chainWithoutMulticall(segments: Record<number, Array<[number, [bigint, bigint, bigint]]>>) {
  return {
    getCode: async (address: string) => (address.toLowerCase() === POOLS ? '0x00' : '0x'),
    call: async (tx: { to: string; data: string }) => {
      if (tx.to.toLowerCase() !== POOLS) return '0x';
      const parsed = iface.parseTransaction({ data: tx.data })!;
      const [id, epoch] = parsed.args.map(Number) as [number, number];
      if (parsed.name === 'positionWithdrawableEpoch') return iface.encodeFunctionResult(parsed.name, [0n]);
      return iface.encodeFunctionResult(parsed.name, [...segments[id]!].reverse().find(([at]) => at <= epoch)![1]);
    },
  };
}

describe('lock history reads without Multicall3', () => {
  it('reads every checkpoint one call at a time instead of assuming Multicall3 exists', async () => {
    expect(MULTICALL3_ADDRESS).not.toBe(POOLS);
    // Staked at 4 and extended at 8: the walk needs a second round of reads.
    const provider = chainWithoutMulticall({ 1: [[4, [10n, 0n, 8n]], [8, [20n, 0n, UINT_MAX]]] });
    const rows: LineageRow[] = [{ id: 1, stakeStartEpoch: 4, closedAtEpoch: 0 }];
    expect(await normalLockStarts(provider as never, POOLS, [1], rows, 10)).toEqual(new Map([[1, 4]]));
  });
});
