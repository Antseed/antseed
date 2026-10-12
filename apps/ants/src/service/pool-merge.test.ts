import { describe, expect, it } from 'vitest';
import { mergePools } from './pool-merge.js';
import type { IndexedPool, IndexedPools } from './indexer.js';

const pool = (over: Partial<IndexedPool>): IndexedPool => ({
  agentId: 1, seller: null, sellerName: null, registered: false, openPositions: 0, totalPositions: 0, securityShareBps: '0', activeStake: '0', pendingStake: '0',
  weight: '0', powerShareBps: 0, lastWeight: '0', usagePoints: '0', weightedUsagePoints: '0', lastUsagePoints: '0', volumeUsdc: '0', lastVolumeUsdc: '0',
  lastEmission: '0', lastEmissionSettled: false, lastRewardPer1kPower: null, projectedEmission: '0', projectedRewardPer1kPower: null, ...over,
});
const network = { epoch: 22, totalPowerWeight: '1000', totalActiveStake: '0', totalSellerPoints: '0', totalWeightedPoolPoints: '0', totalBuyerPoints: '0', volumeUsdc: '0', requests: '0', stakerBudget: '0' };

describe('mergePools', () => {
  const indexed: IndexedPools = {
    currentEpoch: 22,
    network: { current: network, last: null },
    pools: [
      pool({ agentId: 10, seller: '0xaaa', registered: true, openPositions: 3, weight: '600', activeStake: '900', volumeUsdc: '50', lastVolumeUsdc: '40', lastEmission: '12', lastRewardPer1kPower: '30' }),
      pool({ agentId: 11, registered: false, weight: '0' }),
    ],
  };
  const explorer = {
    byAddress: new Map([['0xaaa', { name: 'A', providers: [], modelsServed: 1, uniqueBuyers: 1, requestCount: '1', lifetimeVolumeUsdc: '1', ghostRate: 0, lastSettledAt: 1 }]]),
    byAgent: new Map([[10, '0xaaa'], [12, '0xccc']]),
  };
  const sellerEpochs = new Map([
    ['0xaaa', [{ seller: '0xaaa', epoch: 21, agentId: 10, volumeUsdc: '45', points: '45', weightedPoints: '0', requests: '1' }]],
    ['0xccc', [{ seller: '0xccc', epoch: 22, agentId: null, volumeUsdc: '7', points: '7', weightedPoints: '0', requests: '1' }]],
  ]);

  it('lists indexed pools with your live power, explorer sellers without pools, and pools you stake in', () => {
    const rows = mergePools({ indexed, explorer, sellerEpochs, epochs: [22, 21, 20], own: new Map([[10, { positionIds: [4, 5], power: 150n, stake: 200n }], [99, { positionIds: [6], power: 1n, stake: 1n }]]) });
    // 12 has recent volume, so it ranks above the empty pool 11.
    expect(rows.map((row) => row.agentId)).toEqual([10, 12, 11, 99]);
    const [a, c, b, mine] = rows;
    expect(a).toMatchObject({ stakeable: true, hasPool: true, profile: { name: 'A' }, powerShareBps: 6000, yourPower: '150', yourPoolShareBps: 2500, yourPositionIds: [4, 5], yourStake: '200' });
    expect(a!.volumes).toEqual([{ epoch: 22, usdc: '50' }, { epoch: 21, usdc: '45' }]);
    expect(a!.lastEpochEmission).toBe('12');
    expect(b).toMatchObject({ stakeable: false, hasPool: false, lastEpochEmission: null });
    expect(c).toMatchObject({ seller: '0xccc', stakeable: false, volumes: [{ epoch: 22, usdc: '7' }] });
    expect(mine).toMatchObject({ agentId: 99, yourPositionIds: [6], yourStake: '1' });
  });

  it('orders stakeable pools first, then by power, then by volume', () => {
    const rows = mergePools({
      indexed: { ...indexed, pools: [pool({ agentId: 1, registered: true, weight: '10' }), pool({ agentId: 2, registered: true, weight: '20' }), pool({ agentId: 3, registered: false, volumeUsdc: '5' }), pool({ agentId: 4, registered: false, volumeUsdc: '9' })] },
      explorer: { byAddress: new Map(), byAgent: new Map() }, sellerEpochs: new Map(), epochs: [22, 21], own: new Map(),
    });
    expect(rows.map((row) => row.agentId)).toEqual([2, 1, 4, 3]);
  });
});
