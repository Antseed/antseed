/**
 * Read side for everything that is a list or a history: pools and their
 * per-epoch figures, a wallet's position history, per-epoch usage. It is
 * served by the Antscan indexer (`payments.crypto.explorerApiUrl`), never
 * reconstructed from RPC log scans. Every method returns plain JSON-shaped
 * data; amounts stay as decimal strings.
 */

import { fetchDisplaySnapshot, type DisplaySnapshot } from './display-snapshot.js';
import { fetchRewardPositions, type RewardPositions } from './position-feed.js';

const FETCH_TIMEOUT_MS = 8_000;
const READ_BUDGET_MS = 18_000;
const RETRY_DELAY_MS = 750;
const CACHE_TTL_MS = 15_000;

export interface IndexedStakingEpoch {
  snapshotBlock?: number;
  lastBlockNumber?: number;
  complete?: boolean;
  epoch: number;
  totalPowerWeight: string;
  totalActiveStake: string;
  totalSellerPoints: string;
  totalWeightedPoolPoints: string;
  totalBuyerPoints: string;
  volumeUsdc: string;
  requests: string;
  stakerBudget: string;
}

export interface IndexedPool {
  participationComplete?: boolean;
  agentId: number;
  seller: string | null;
  sellerName: string | null;
  registered: boolean;
  openPositions: number;
  totalPositions: number;
  securityShareBps: string;
  activeStake: string;
  pendingStake: string;
  weight: string;
  powerShareBps: number;
  lastWeight: string;
  usagePoints: string;
  weightedUsagePoints: string;
  lastUsagePoints: string;
  volumeUsdc: string;
  lastVolumeUsdc: string;
  volumeAvailable?: boolean;
  lastVolumeAvailable?: boolean;
  lastEmission: string;
  lastEmissionSettled: boolean;
  /** Preserve absent/invalid historical inputs instead of treating them as a real zero. */
  historicalYield?: { power: string; reward: string; settled: boolean } | null;
  stakers?: number | null;
  lastRewardPer1kPower: string | null;
  projectedEmission: string;
  projectedRewardPer1kPower: string | null;
}

export interface IndexedPools {
  currentEpoch: number;
  network: { current: IndexedStakingEpoch | null; last: IndexedStakingEpoch | null };
  pools: IndexedPool[];
}

export interface IndexedPoolEpoch {
  epoch: number;
  weight: string;
  activeStake: string;
  usagePoints: string;
  weightedUsagePoints: string;
  volumeUsdc: string;
  requests: string;
  settledEmission: string;
  settled: boolean;
}

export interface IndexedPoolDetail {
  activeStake?: string | null;
  pool: (IndexedPool & { firstStakeAt: number | null }) | null;
  epochs: IndexedPoolEpoch[];
  openPositions: number | null;
  stakers: number | null;
  /** Stake in open positions waiting for their activation epoch; null when the explorer predates the field. */
  pendingStake: string | null;
}

export interface IndexedPosition {
  lastBlockNumber?: number;
  id: number;
  owner: string;
  agentId: number;
  amount: string;
  weightAmount: string;
  stakeStartEpoch: number;
  stakeEndEpoch: number;
  closedAtEpoch: number;
  closedBy: 'split' | 'merge' | 'move' | 'withdraw' | null;
  replacementIds: number[];
  sourceId: number | null;
  restaked: boolean;
  maxLocked: boolean;
  withdrawn: boolean;
  returnedAmount: string;
  slashedAmount: string;
  createdAt: number;
  closedAt: number | null;
  /** Live power this epoch as read by the explorer; null when the explorer could not read it or predates the field. */
  power?: string | null;
  nextPower?: string | null;
}

export interface IndexedSellerEpoch { seller: string; epoch: number; agentId: number | null; volumeUsdc: string; points: string; weightedPoints: string; requests: string; }
export interface IndexedBuyerEpoch { buyer: string; epoch: number; volumeUsdc: string; points: string; weightedPoints: string; requests: string; }
export interface IndexedParticipant { address: string; currentEpoch: number; seller: IndexedSellerEpoch[]; buyer: IndexedBuyerEpoch[]; }
/** Network settlement volume per epoch from the explorer's epoch metrics (covers legacy epochs too). */
export interface IndexedEpochMetric { epoch: number; volumeUsdc: string; requests: string; }

export interface Indexer {
  rewardPositions?(owner: string, outstanding?: boolean): Promise<RewardPositions>;
  displaySnapshot?(epoch: number): Promise<DisplaySnapshot>;
  invalidate?(): void;
  readonly baseUrl: string;
  pools(): Promise<IndexedPools>;
  pool(agentId: number, epochs?: number): Promise<IndexedPoolDetail>;
  positions(owner: string, includeClosed?: boolean): Promise<IndexedPosition[]>;
  stakingEpochs(limit?: number): Promise<IndexedStakingEpoch[]>;
  /** Settled volume per seller (lowercase address) for the last `epochs` epochs, newest first. */
  sellerEpochs(epochs?: number): Promise<Map<string, IndexedSellerEpoch[]>>;
  participant(address: string, epochs?: number): Promise<IndexedParticipant>;
  epochMetrics(): Promise<IndexedEpochMetric[]>;
}

export class IndexerError extends Error {
  constructor(message: string, readonly url: string, readonly status?: number) {
    super(message);
    this.name = 'IndexerError';
  }
}

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value: unknown): string => (value === null || value === undefined ? '0' : String(value));
const lower = (value: unknown): string | null => (typeof value === 'string' && value ? value.toLowerCase() : null);
/** `convert(value)`, or null when the field is absent. */
const optional = <T>(value: unknown, convert: (value: unknown) => T): T | null => (value === null || value === undefined ? null : convert(value));
/** A non-negative integer string, or null for anything else (absent field, error marker, older explorer). */
const decimalOrNull = (value: unknown): string | null => (/^\d+$/.test(String(value ?? '')) ? String(value) : null);
/** A non-negative safe integer count, or null. */
const countOrNull = (value: unknown): number | null => (value != null && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null);
const CLOSE_REASONS = ['split', 'merge', 'move', 'withdraw'] as const;

function toStakingEpoch(row: Record<string, unknown> | null): IndexedStakingEpoch | null {
  if (!row) return null;
  return {
    snapshotBlock: row['snapshotBlock'] == null ? undefined : num(row['snapshotBlock']),
    lastBlockNumber: row['lastBlockNumber'] == null ? undefined : num(row['lastBlockNumber']),
    complete: ['epoch', 'totalActiveStake', 'totalPowerWeight', 'stakerBudget', 'totalWeightedPoolPoints'].every(key => /^\d+$/.test(String(row[key] ?? ''))),
    epoch: num(row['epoch']),
    totalPowerWeight: str(row['totalPowerWeight']),
    totalActiveStake: str(row['totalActiveStake']),
    totalSellerPoints: str(row['totalSellerPoints']),
    totalWeightedPoolPoints: str(row['totalWeightedPoolPoints']),
    totalBuyerPoints: str(row['totalBuyerPoints']),
    volumeUsdc: str(row['volumeUsdc']),
    requests: str(row['requests']),
    stakerBudget: str(row['stakerBudget']),
  };
}

function toPool(row: Record<string, unknown>): IndexedPool & { firstStakeAt: number | null } {
  return {
    participationComplete: ['openPositions', 'totalPositions'].every(key => row[key] != null && Number.isSafeInteger(Number(row[key])) && Number(row[key]) >= 0),
    agentId: num(row['agentId']),
    seller: lower(row['seller']),
    sellerName: typeof row['sellerName'] === 'string' ? row['sellerName'] : null,
    registered: row['registered'] === true,
    openPositions: num(row['openPositions']),
    totalPositions: num(row['totalPositions']),
    securityShareBps: str(row['securityShareBps']),
    activeStake: str(row['activeStake']),
    pendingStake: str(row['pendingStake']),
    weight: str(row['weight']),
    powerShareBps: num(row['powerShareBps']),
    lastWeight: str(row['lastWeight']),
    usagePoints: str(row['usagePoints']),
    weightedUsagePoints: str(row['weightedUsagePoints']),
    lastUsagePoints: str(row['lastUsagePoints']),
    volumeUsdc: str(row['volumeUsdc']),
    lastVolumeUsdc: str(row['lastVolumeUsdc']),
    volumeAvailable: row['volumeUsdc'] != null,
    lastVolumeAvailable: row['lastVolumeUsdc'] != null,
    lastEmission: str(row['lastEmission']),
    lastEmissionSettled: row['lastEmissionSettled'] === true,
    historicalYield: /^\d+$/.test(String(row['lastWeight'] ?? '')) && /^\d+$/.test(String(row['lastEmission'] ?? '')) && typeof row['lastEmissionSettled'] === 'boolean'
      ? { power: String(row['lastWeight']), reward: String(row['lastEmission']), settled: row['lastEmissionSettled'] } : null,
    stakers: countOrNull(row['stakers']),
    lastRewardPer1kPower: optional(row['lastRewardPer1kPower'], str),
    projectedEmission: str(row['projectedEmission']),
    projectedRewardPer1kPower: optional(row['projectedRewardPer1kPower'], str),
    firstStakeAt: optional(row['firstStakeAt'], num),
  };
}

function toPosition(row: Record<string, unknown>): IndexedPosition {
  const closedBy = CLOSE_REASONS.find((reason) => reason === row['closedBy']) ?? null;
  return {
    lastBlockNumber: row['lastBlockNumber'] == null ? undefined : num(row['lastBlockNumber']),
    id: num(row['id']),
    owner: lower(row['owner']) ?? '',
    agentId: num(row['agentId']),
    amount: str(row['amount']),
    weightAmount: str(row['weightAmount']),
    stakeStartEpoch: num(row['stakeStartEpoch']),
    stakeEndEpoch: num(row['stakeEndEpoch']),
    closedAtEpoch: num(row['closedAtEpoch']),
    closedBy,
    replacementIds: Array.isArray(row['replacementIds']) ? (row['replacementIds'] as unknown[]).map(num) : [],
    sourceId: optional(row['sourceId'], num),
    restaked: row['restaked'] === true,
    maxLocked: row['maxLocked'] === true,
    withdrawn: row['withdrawn'] === true,
    returnedAmount: str(row['returnedAmount']),
    slashedAmount: str(row['slashedAmount']),
    createdAt: num(row['createdAt']),
    closedAt: optional(row['closedAt'], num),
    power: decimalOrNull(row['power']),
    nextPower: decimalOrNull(row['nextPower']),
  };
}

const toSellerEpoch = (row: Record<string, unknown>): IndexedSellerEpoch => ({
  seller: lower(row['seller']) ?? '',
  epoch: num(row['epoch']),
  agentId: optional(row['agentId'], num),
  volumeUsdc: str(row['volumeUsdc']),
  points: str(row['points']),
  weightedPoints: str(row['weightedPoints']),
  requests: str(row['requests']),
});
const toBuyerEpoch = (row: Record<string, unknown>): IndexedBuyerEpoch => ({
  buyer: lower(row['buyer']) ?? '',
  epoch: num(row['epoch']),
  volumeUsdc: str(row['volumeUsdc']),
  points: str(row['points']),
  weightedPoints: str(row['weightedPoints']),
  requests: str(row['requests']),
});

export class AntscanIndexer implements Indexer {
  readonly baseUrl: string;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(baseUrl: string, private readonly fetchImpl: typeof fetch = fetch, private readonly ttlMs = CACHE_TTL_MS) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  invalidate(): void { this.cache.clear(); this.pending.clear(); }

  displaySnapshot(epoch: number): Promise<DisplaySnapshot> {
    const key = `display:${epoch}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as Promise<DisplaySnapshot>;
    const value = fetchDisplaySnapshot(this.baseUrl, this.fetchImpl, epoch);
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }

  private get<T>(path: string, cache = true): Promise<T> {
    const running = this.pending.get(path);
    if (cache && running) return running as Promise<T>;
    const hit = this.cache.get(path);
    if (cache && hit && Date.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const url = `${this.baseUrl}${path}`;
    const value = this.read<T>(url);
    if (cache) {
      this.pending.set(path, value);
      value.then(() => {
        if (this.pending.get(path) !== value) return;
        this.pending.delete(path);
        this.cache.set(path, { at: Date.now(), value });
      }, () => {
        if (this.pending.get(path) === value) this.pending.delete(path);
      });
    }
    return value;
  }

  private async read<T>(url: string): Promise<T> {
    const deadline = Date.now() + READ_BUDGET_MS;
    for (let attempt = 0; ; attempt++) {
      let retryAfter: string | null = null;
      let failure: IndexerError;
      try {
        const response = await this.fetchImpl(url, {
          signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, Math.max(1, deadline - Date.now()))),
          headers: { accept: 'application/json' },
        });
        if (response.ok) return await response.json() as T;
        retryAfter = response.headers.get('retry-after');
        await response.body?.cancel();
        failure = new IndexerError(`Explorer responded with HTTP ${response.status}`, url, response.status);
        if (response.status !== 408 && response.status !== 429 && response.status < 500) throw failure;
      } catch (error) {
        if (error instanceof IndexerError || error instanceof SyntaxError) throw error;
        failure = new IndexerError(`Explorer unreachable: ${(error as Error).message}`, url);
      }
      const requestedDelay = retryAfter === null ? 0 : /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1_000 : Date.parse(retryAfter) - Date.now();
      const delay = Math.max(RETRY_DELAY_MS, Number.isFinite(requestedDelay) ? requestedDelay : 0);
      if (attempt >= 1 || delay + FETCH_TIMEOUT_MS > deadline - Date.now()) throw failure;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  async pools(): Promise<IndexedPools> {
    const raw = await this.get<{ currentEpoch: unknown; network: { current: Record<string, unknown> | null; last: Record<string, unknown> | null }; pools: Record<string, unknown>[] }>('/api/staking/pools');
    return {
      currentEpoch: num(raw.currentEpoch),
      network: { current: toStakingEpoch(raw.network?.current ?? null), last: toStakingEpoch(raw.network?.last ?? null) },
      pools: (raw.pools ?? []).map(toPool),
    };
  }

  async pool(agentId: number, epochs = 8): Promise<IndexedPoolDetail> {
    const raw = await this.get<{ pool: Record<string, unknown> | null; epochs: Record<string, unknown>[]; openPositions: unknown; stakers: unknown; pendingStake?: unknown; activeStake?: unknown }>(`/api/staking/pools/${agentId}?epochs=${epochs}`);
    return {
      pool: raw.pool ? toPool(raw.pool) : null,
      epochs: (raw.epochs ?? []).filter(row => row['volumeUsdc'] != null).map((row) => ({
        epoch: num(row['epoch']), weight: str(row['weight']), activeStake: str(row['activeStake']), usagePoints: str(row['usagePoints']), weightedUsagePoints: str(row['weightedUsagePoints']),
        volumeUsdc: str(row['volumeUsdc']), requests: str(row['requests']), settledEmission: str(row['settledEmission']), settled: row['settled'] === true,
      })),
      openPositions: countOrNull(raw.openPositions),
      stakers: countOrNull(raw.stakers),
      pendingStake: decimalOrNull(raw.pendingStake),
      activeStake: decimalOrNull(raw.activeStake),
    };
  }

  async positions(owner: string, includeClosed = true): Promise<IndexedPosition[]> {
    const raw = await this.get<{ positions: Record<string, unknown>[] }>(`/api/staking/positions?owner=${owner.toLowerCase()}${includeClosed ? '&includeClosed=1' : ''}`);
    return (raw.positions ?? []).map(toPosition);
  }

  rewardPositions(owner: string, outstanding = false): Promise<RewardPositions> {
    const key = `rewards:${owner.toLowerCase()}:${outstanding}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as Promise<RewardPositions>;
    const value = (async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await fetchRewardPositions(owner, outstanding, path => this.get(path, false)); }
        catch (error) {
          if (!(error instanceof IndexerError && error.status === 409 && attempt === 0)) throw error;
        }
      }
    })();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }

  async stakingEpochs(limit = 8): Promise<IndexedStakingEpoch[]> {
    const raw = await this.get<Record<string, unknown>[]>(`/api/staking/epochs?limit=${limit}`);
    return (raw ?? []).map((row) => toStakingEpoch(row)!);
  }

  async sellerEpochs(epochs = 3): Promise<Map<string, IndexedSellerEpoch[]>> {
    const raw = await this.get<{ rows: Record<string, unknown>[] }>(`/api/staking/seller-epochs?epochs=${epochs}`);
    const bySeller = new Map<string, IndexedSellerEpoch[]>();
    for (const row of (raw.rows ?? []).map(toSellerEpoch)) bySeller.set(row.seller, [...(bySeller.get(row.seller) ?? []), row]);
    return bySeller;
  }

  async participant(address: string, epochs = 8): Promise<IndexedParticipant> {
    const raw = await this.get<{ address: unknown; currentEpoch: unknown; seller: Record<string, unknown>[]; buyer: Record<string, unknown>[] }>(`/api/staking/participants/${address.toLowerCase()}?epochs=${epochs}`);
    return { address: address.toLowerCase(), currentEpoch: num(raw.currentEpoch), seller: (raw.seller ?? []).map(toSellerEpoch), buyer: (raw.buyer ?? []).map(toBuyerEpoch) };
  }

  async epochMetrics(): Promise<IndexedEpochMetric[]> {
    const raw = await this.get<Record<string, unknown>[]>('/api/epochs');
    return (raw ?? []).map((row) => ({ epoch: num(row['epoch']), volumeUsdc: str(row['volumeUsdc']), requests: str(row['requests']) }));
  }
}

/** The indexer for a chain config; null when no explorer is configured (`explorerApiUrl: ''`). */
export function createIndexer(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch): Indexer | null {
  return baseUrl ? new AntscanIndexer(baseUrl, fetchImpl) : null;
}
