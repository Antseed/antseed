import type { IndexedPosition } from './indexer.js';

export interface LivePosition extends IndexedPosition {
  state: 'pending' | 'active' | 'matured' | 'closed' | 'withdrawn';
  withdrawableEpoch: number | null;
  maxLockedNext: boolean | null;
  changePending: boolean | null;
}
export interface StakeTotals { activeStake: string; pendingStake: string; power: string; }
export interface LivePositions {
  positions: LivePosition[];
  summary: Array<StakeTotals & { agentId: number; positionIds: number[] }>;
  totals: StakeTotals;
  currentEpoch: number;
  liveSource: { currentEpoch: number; fetchedAt: number; stale: boolean; complete: boolean };
  liveError?: string;
}
export interface RewardPosition extends LivePosition {
  rewards: { status: 'available' | 'unavailable'; pending: string | null; claimedThroughEpoch: number | null; calculatedThroughEpoch: number | null; requiresPoolIndexing: boolean | null };
}
export interface RewardSource {
  schemaVersion: number;
  chainId: number;
  contracts: { sellerPools: string; sellerPoolsRewards: string };
  indexedBlock: number;
  indexedBlockHash: string;
  indexedAt: number;
  revision: string;
  stale: boolean;
  complete: boolean;
  historyComplete: boolean;
  historyFromBlock: number;
}
export interface RewardPositions extends LivePositions { positions: RewardPosition[]; source: RewardSource; }

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Antscan position response');
  return value as Record<string, unknown>;
}
function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid Antscan amount');
  return value;
}
function integer(value: unknown): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid Antscan integer');
  return Number(value);
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid Antscan boolean');
  return value;
}
function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{40}$/.test(value)) throw new Error('Invalid Antscan address');
  return value.toLowerCase();
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid Antscan list');
  return value;
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value == null ? null : parse(value); }
const CLOSE_REASONS = ['split', 'merge', 'move', 'withdraw'];
const POSITION_STATES = ['pending', 'active', 'matured', 'closed', 'withdrawn'];
const CURSOR = /^[\w-]{1,1024}$/;

function position(value: unknown, owner: string): IndexedPosition {
  const row = object(value);
  if (address(row.owner) !== owner.toLowerCase()) throw new Error('Antscan returned a different position owner');
  const id = integer(row.id);
  if (id === 0) throw new Error('Invalid Antscan position id');
  const closedBy = nullable(row.closedBy, String);
  if (closedBy !== null && !CLOSE_REASONS.includes(closedBy)) throw new Error('Invalid position close reason');
  return {
    id, owner: address(row.owner), agentId: integer(row.agentId), amount: decimal(row.amount), weightAmount: decimal(row.weightAmount),
    stakeStartEpoch: integer(row.stakeStartEpoch), stakeEndEpoch: integer(row.stakeEndEpoch), closedAtEpoch: integer(row.closedAtEpoch),
    withdrawn: boolean(row.withdrawn), maxLocked: boolean(row.maxLocked), restaked: boolean(row.restaked),
    closedBy: closedBy as IndexedPosition['closedBy'], replacementIds: array(row.replacementIds ?? []).map(integer),
    sourceId: nullable(row.sourceId, integer), returnedAmount: decimal(row.returnedAmount), slashedAmount: decimal(row.slashedAmount),
    createdAt: integer(row.createdAt), closedAt: nullable(row.closedAt, integer),
  };
}
function unique(positions: IndexedPosition[]): void {
  if (new Set(positions.map(row => row.id)).size !== positions.length) throw new Error('Duplicate Antscan positions');
}
function rewardSource(value: unknown): RewardSource {
  const source = object(value);
  const contracts = object(source.contracts);
  const hash = source.indexedBlockHash;
  const revision = source.revision;
  if (source.schemaVersion !== 1 || typeof hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(hash) || typeof revision !== 'string' || !revision.startsWith(`${hash}:`)) throw new Error('Invalid reward checkpoint');
  return {
    schemaVersion: 1,
    chainId: integer(source.chainId),
    contracts: { sellerPools: address(contracts.sellerPools), sellerPoolsRewards: address(contracts.sellerPoolsRewards) },
    indexedBlock: integer(source.indexedBlock),
    indexedBlockHash: hash,
    indexedAt: integer(source.indexedAt),
    revision,
    stale: boolean(source.stale),
    complete: boolean(source.complete),
    historyComplete: boolean(source.historyComplete),
    historyFromBlock: integer(source.historyFromBlock),
  };
}

function positionRewards(value: unknown, currentEpoch: number): RewardPosition['rewards'] {
  const reward = object(value);
  if (reward.status === 'unavailable') return { status: 'unavailable', pending: null, claimedThroughEpoch: null, calculatedThroughEpoch: null, requiresPoolIndexing: null };
  if (reward.status !== 'available') throw new Error('Invalid reward status');
  const calculatedThroughEpoch = integer(reward.calculatedThroughEpoch);
  if (calculatedThroughEpoch > currentEpoch) throw new Error('Reward calculation is ahead of its epoch');
  return { status: 'available', pending: decimal(reward.pending), claimedThroughEpoch: integer(reward.claimedThroughEpoch), calculatedThroughEpoch, requiresPoolIndexing: boolean(reward.requiresPoolIndexing) };
}

/** Pagination block of a reward page; `nextCursor` is required exactly when `hasMore`. */
function pagination(value: unknown, pageSize: number): { hasMore: boolean; nextCursor: string | null } {
  const page = object(value);
  const hasMore = boolean(page.hasMore);
  const limit = integer(page.limit);
  const cursor = page.nextCursor;
  if (limit < 1 || limit > 100 || pageSize > limit) throw new Error('Invalid reward pagination');
  if (hasMore && (typeof cursor !== 'string' || !CURSOR.test(cursor) || pageSize === 0)) throw new Error('Invalid reward pagination');
  if (!hasMore && cursor !== null) throw new Error('Invalid reward pagination');
  return { hasMore, nextCursor: hasMore ? cursor as string : null };
}

export function parseRewardPage(value: unknown, owner: string) {
  const raw = object(value);
  if (raw.requiresLiveValidation !== true || !raw.source || !raw.pagination) throw new Error('Antscan deployment does not provide indexed staking rewards yet');
  if (address(raw.owner) !== owner.toLowerCase()) throw new Error('Invalid reward response identity');
  const source = rewardSource(raw.source);
  const currentEpoch = integer(raw.currentEpoch);
  const live = object(raw.liveSource);
  const liveSource = { currentEpoch: integer(live.currentEpoch), fetchedAt: live.fetchedAt === null ? 0 : integer(live.fetchedAt), stale: boolean(live.stale), complete: boolean(live.complete) };
  const positions = array(raw.positions).map((value): RewardPosition => {
    const row = object(value);
    if (!POSITION_STATES.includes(String(row.state))) throw new Error('Invalid position state');
    return { ...position(row, owner), state: row.state as LivePosition['state'], power: nullable(row.power, decimal), nextPower: nullable(row.nextPower, decimal),
      withdrawableEpoch: nullable(row.withdrawableEpoch, integer), maxLockedNext: nullable(row.maxLockedNext, boolean), changePending: nullable(row.changePending, boolean),
      rewards: positionRewards(row.rewards, currentEpoch) };
  });
  unique(positions);
  return { positions, source, currentEpoch, liveSource, ...(raw.liveError ? { liveError: String(raw.liveError) } : {}), ...pagination(raw.pagination, positions.length) };
}

function summarize(snapshot: RewardPositions): RewardPositions {
  const summary = new Map<number, LivePositions['summary'][number]>();
  for (const position of snapshot.positions) {
    if (position.withdrawn || (position.closedAtEpoch !== 0 && position.closedAtEpoch <= snapshot.liveSource.currentEpoch)) continue;
    const pool = summary.get(position.agentId) ?? { agentId: position.agentId, positionIds: [], activeStake: '0', pendingStake: '0', power: '0' };
    pool.positionIds.push(position.id);
    // A split/merge/move source closing next epoch keeps its power until then, but its principal already lives in the replacement.
    if (position.stakeStartEpoch <= snapshot.liveSource.currentEpoch) pool.activeStake = (BigInt(pool.activeStake) + BigInt(position.amount)).toString();
    else if (position.closedAtEpoch === 0) pool.pendingStake = (BigInt(pool.pendingStake) + BigInt(position.amount)).toString();
    pool.power = (BigInt(pool.power) + BigInt(position.power ?? '0')).toString();
    summary.set(position.agentId, pool);
  }
  snapshot.summary = [...summary.values()];
  for (const field of ['activeStake', 'pendingStake', 'power'] as const) snapshot.totals[field] = snapshot.summary.reduce((total, pool) => total + BigInt(pool[field]), 0n).toString();
  return snapshot;
}

export async function fetchRewardPositions(owner: string, outstanding: boolean, get: (path: string) => Promise<unknown>): Promise<RewardPositions> {
  const query = new URLSearchParams({ owner: owner.toLowerCase(), include: 'rewards', includeClosed: '1', limit: '100', ...(outstanding ? { rewardStatus: 'outstanding' } : {}) });
  let snapshot: RewardPositions | undefined;
  let cursor: string | null = null;
  const cursors = new Set<string>();
  for (let page = 0; page < 100; page++) {
    if (cursor) query.set('cursor', cursor);
    const next = parseRewardPage(await get(`/api/staking/positions?${query}`), owner);
    if (snapshot && (JSON.stringify(snapshot.source) !== JSON.stringify(next.source) || snapshot.currentEpoch !== next.currentEpoch)) throw new Error('Antscan reward snapshot changed between pages');
    snapshot ??= { positions: [], source: next.source, currentEpoch: next.currentEpoch, liveSource: { ...next.liveSource }, summary: [], totals: { activeStake: '0', pendingStake: '0', power: '0' } };
    snapshot.liveSource.fetchedAt = Math.min(snapshot.liveSource.fetchedAt, next.liveSource.fetchedAt);
    snapshot.liveSource.stale ||= next.liveSource.stale;
    snapshot.liveSource.complete &&= next.liveSource.complete && snapshot.liveSource.currentEpoch === next.liveSource.currentEpoch;
    if (next.liveError) snapshot.liveError = next.liveError;
    snapshot.positions.push(...next.positions);
    unique(snapshot.positions);
    if (!next.hasMore) return summarize(snapshot);
    cursor = next.nextCursor!;
    if (cursors.has(cursor)) throw new Error('Repeated Antscan reward cursor');
    cursors.add(cursor);
  }
  throw new Error('Antscan reward pagination limit exceeded; history is incomplete');
}
