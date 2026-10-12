import type { PoolView, EpochVolume, SellerProfile } from '../api-types.js';
import type { ExplorerSellers } from './explorer.js';
import type { IndexedPool, IndexedPools, IndexedSellerEpoch } from './indexer.js';

export interface MergeInput {
  indexed: IndexedPools;
  explorer: ExplorerSellers;
  /** Settled volume per seller (lowercase) per epoch, newest first. */
  sellerEpochs: Map<string, IndexedSellerEpoch[]>;
  /** Epochs to show volume for, current first. */
  epochs: number[];
  /** Your open positions per agent: live power this epoch, stake counting now, and stake pending activation. */
  own: Map<number, { positionIds: number[]; power: bigint; stake: bigint; pending: bigint }>;
}

function bps(part: bigint, whole: bigint): number {
  return whole === 0n ? 0 : Number(part * 10_000n / whole);
}

/** The pool summary carries volume for the current (index 0) and previous (index 1) epoch only. */
function poolVolumeAt(pool: IndexedPool | undefined, index: number): string | null {
  if (!pool) return null;
  if (index === 0) return pool.volumeAvailable === false ? null : pool.volumeUsdc;
  if (index === 1) return pool.lastVolumeAvailable === false ? null : pool.lastVolumeUsdc;
  return null;
}

function volumesFor(seller: string | null, epochs: number[], sellerEpochs: Map<string, IndexedSellerEpoch[]>, pool?: IndexedPool): EpochVolume[] {
  const rows = seller ? sellerEpochs.get(seller.toLowerCase()) ?? [] : [];
  return epochs.flatMap((epoch, index) => {
    const sellerVolume = rows.find((entry) => entry.epoch === epoch)?.volumeUsdc;
    if (sellerVolume) return { epoch, usdc: sellerVolume };
    const poolVolume = poolVolumeAt(pool, index);
    return poolVolume === null ? [] : [{ epoch, usdc: poolVolume }];
  });
}

/**
 * Build the dashboard's pool rows from indexer data: every indexed pool, plus
 * explorer sellers without a pool (so their volume is visible before anyone
 * stakes), plus pools this wallet stakes in even if the indexer lags. No
 * chain reads happen here; the caller supplies this wallet's live power.
 */
export function mergePools(input: MergeInput): PoolView[] {
  const { indexed, explorer, sellerEpochs, epochs, own } = input;
  const totalPower = BigInt(indexed.network.current?.totalPowerWeight ?? '0');
  const rows = new Map<number, PoolView>();
  const profileFor = (seller: string | null): SellerProfile | null => (seller ? explorer.byAddress.get(seller.toLowerCase()) ?? null : null);

  for (const pool of indexed.pools) {
    const seller = pool.seller ?? explorer.byAgent.get(pool.agentId) ?? null;
    const mine = own.get(pool.agentId);
    const weight = BigInt(pool.weight);
    rows.set(pool.agentId, {
      agentId: pool.agentId,
      seller,
      profile: profileFor(seller),
      hasPool: weight !== 0n || pool.openPositions > 0,
      openPositions: pool.participationComplete === false ? undefined : pool.openPositions,
      totalPositions: pool.participationComplete === false ? undefined : pool.totalPositions,
      stakers: pool.stakers ?? null,
      stakeable: pool.registered,
      activeStake: pool.activeStake,
      pendingStake: pool.pendingStake,
      weight: pool.weight,
      powerShareBps: pool.powerShareBps || bps(weight, totalPower),
      securityShareBps: Number(pool.securityShareBps),
      volumes: volumesFor(seller, epochs, sellerEpochs, pool),
      usagePoints: pool.usagePoints,
      weightedUsagePoints: pool.weightedUsagePoints,
      lastEpochUsagePoints: pool.lastUsagePoints,
      lastEpochEmission: pool.lastEmission !== '0' ? pool.lastEmission : null,
      lastEpochEmissionSettled: pool.lastEmissionSettled,
      lastEpochRewardPer1kPower: pool.lastRewardPer1kPower,
      projectedRewardPer1kPower: pool.projectedRewardPer1kPower,
      yourStake: (mine?.stake ?? 0n).toString(),
      yourPendingStake: (mine?.pending ?? 0n).toString(),
      yourPower: (mine?.power ?? 0n).toString(),
      yourPoolShareBps: bps(mine?.power ?? 0n, weight),
      yourPositionIds: mine?.positionIds ?? [],
    });
  }

  const candidates = new Set<number>([...explorer.byAgent.keys(), ...own.keys()]);
  for (const agentId of candidates) {
    if (rows.has(agentId)) continue;
    const seller = explorer.byAgent.get(agentId) ?? null;
    const mine = own.get(agentId);
    rows.set(agentId, {
      agentId,
      seller,
      profile: profileFor(seller),
      hasPool: false,
      stakeable: false,
      activeStake: (mine?.stake ?? 0n).toString(),
      pendingStake: (mine?.pending ?? 0n).toString(),
      weight: '0',
      powerShareBps: 0,
      securityShareBps: 0,
      volumes: volumesFor(seller, epochs, sellerEpochs),
      usagePoints: '0',
      weightedUsagePoints: '0',
      lastEpochUsagePoints: '0',
      lastEpochEmission: null,
      lastEpochEmissionSettled: false,
      lastEpochRewardPer1kPower: null,
      projectedRewardPer1kPower: null,
      yourStake: (mine?.stake ?? 0n).toString(),
      yourPendingStake: (mine?.pending ?? 0n).toString(),
      yourPower: (mine?.power ?? 0n).toString(),
      yourPoolShareBps: 0,
      yourPositionIds: mine?.positionIds ?? [],
    });
  }
  return sortPools([...rows.values()]);
}

/** Stakeable pools first, then by power, then by recent volume, then by agent id. */
export function sortPools(views: PoolView[]): PoolView[] {
  const volume = (pool: PoolView) => BigInt(pool.volumes[1]?.usdc ?? '0') + BigInt(pool.volumes[0]?.usdc ?? '0');
  const compare = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0);
  return views.sort((a, b) => Number(b.stakeable) - Number(a.stakeable) || compare(BigInt(a.weight), BigInt(b.weight)) || compare(volume(a), volume(b)) || a.agentId - b.agentId);
}
