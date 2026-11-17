import { Interface } from 'ethers';
import { multicallRead } from '@antseed/node/payments';
import type { SellerPoolConfig } from '@antseed/node/payments';
import type { AbstractProvider } from 'ethers';

/**
 * The pool keeps each position's early-exit "normal" lock start in a private
 * checkpoint. `mergeStakes` requires it to match across sources, and the
 * early-exit slash divides by `normalEnd - normalStart`. The public
 * `stakeStartEpoch` is not that value for restructured positions, so it is
 * rebuilt here from the pool's own rules:
 *
 *   - `stake` / reward restake: the position's `stakeStartEpoch`.
 *   - `splitStake` / `mergeStakes` / `moveStake`: inherited from the sources.
 *     A restructured position has `positionWithdrawableEpoch == stakeStartEpoch`
 *     (fresh stakes have 0), which tells the two apart without logs.
 *   - `disableMaxLock`: reset to the disable's effective epoch, the epoch the
 *     position's max-lock power drops back to zero.
 *   - `extendLock`: unchanged.
 *
 * Lineage (which closed positions a replacement came from) comes from the
 * indexer's `replacementIds`; max-lock history is read from
 * `positionPowerSegmentAt` checkpoints. Unknown history yields `null`, never a
 * guess. Known gap: enabling and disabling max lock within the same epoch
 * leaves no max-lock checkpoint with power, so that reset is not detected.
 */

export interface LineageRow {
  id: number;
  stakeStartEpoch: number;
  closedAtEpoch: number;
  closedBy?: 'split' | 'merge' | 'move' | 'withdraw' | null;
  replacementIds?: number[];
}

export interface LockHistory {
  /** True when the pool created this position from other positions (split, merge, move). */
  restructured: boolean;
  /** Effective epoch of the latest max-lock disable, or null when it never left max lock. */
  maxLockResetEpoch: number | null;
  /** True while the position is max locked at the read epoch (normal start is 0 on chain). */
  maxLocked: boolean;
}

/** Replacement id → the closed positions it was built from. */
export function restructureSources(rows: LineageRow[]): Map<number, number[]> {
  const sources = new Map<number, number[]>();
  for (const row of rows) {
    if (row.closedBy !== 'split' && row.closedBy !== 'merge' && row.closedBy !== 'move') continue;
    for (const replacement of row.replacementIds ?? []) sources.set(replacement, [...(sources.get(replacement) ?? []), row.id]);
  }
  return sources;
}

/** Ids whose history is needed to resolve `ids`: the positions and all their known ancestors. */
export function lineageIds(ids: number[], sources: Map<number, number[]>): number[] {
  const seen = new Set<number>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(sources.get(id) ?? []));
  }
  return [...seen];
}

/**
 * Normal lock start per id, or null when the history needed to know it is
 * missing (a restructured position whose sources this wallet never held, or a
 * position whose history could not be read).
 */
export function resolveNormalStarts(
  ids: number[],
  rows: Map<number, LineageRow>,
  sources: Map<number, number[]>,
  history: Map<number, LockHistory>,
): Map<number, number | null> {
  const resolved = new Map<number, number | null>();
  const resolve = (id: number, depth: number): number | null => {
    if (resolved.has(id)) return resolved.get(id)!;
    const row = rows.get(id);
    const lock = history.get(id);
    let start: number | null = null;
    if (row && lock && !lock.maxLocked && depth < 256) {
      if (lock.maxLockResetEpoch !== null) start = lock.maxLockResetEpoch;
      else if (!lock.restructured) start = row.stakeStartEpoch;
      else {
        // Merge sources share one normal start (the pool refuses otherwise); split and move have one source.
        const inherited = (sources.get(id) ?? []).map(source => resolve(source, depth + 1));
        start = inherited.length > 0 && inherited.every(value => value !== null && value === inherited[0]) ? inherited[0]! : null;
      }
    }
    resolved.set(id, start);
    return start;
  };
  for (const id of ids) resolve(id, 0);
  return new Map(ids.map(id => [id, resolved.get(id) ?? null]));
}

/**
 * The pool's early-exit slash for a withdrawal at `epoch`, using the normal
 * lock start (mirror of `_earlyExitSlashBps`; the close epoch never precedes
 * the public `stakeStartEpoch`).
 */
export function earlyExitSlashBpsFrom(
  position: { stakeStartEpoch: number; stakeEndEpoch: number },
  normalStartEpoch: number,
  epoch: number,
  config: Pick<SellerPoolConfig, 'maxSlashBps' | 'minEarlyExitSlashBps'>,
  maxLocked = false,
): number {
  if (maxLocked) return config.maxSlashBps;
  const closeEpoch = Math.max(epoch, position.stakeStartEpoch);
  const end = position.stakeEndEpoch;
  if (normalStartEpoch === 0 || closeEpoch >= end) return 0;
  const total = end - normalStartEpoch;
  if (total <= 0) return 0;
  const linear = Math.floor(config.maxSlashBps * (end - closeEpoch) / total);
  return Math.max(config.minEarlyExitSlashBps, Math.min(config.maxSlashBps, linear));
}

const POOLS_IFACE = new Interface([
  'function positionWithdrawableEpoch(uint256 positionId) view returns (uint64)',
  'function positionPowerSegmentAt(uint256 positionId, uint256 epoch) view returns (uint256 normalEndEpoch, uint256 maxLockPower, uint256 nextChangeEpoch)',
]);
const MAX_SEGMENT_ROUNDS = 32;

/**
 * Read each position's lock history from the pool's checkpoints, batched
 * through Multicall3: one round for the withdrawable epoch and first segment,
 * then one round per further checkpoint (extend, max-lock enable or disable).
 * `cache` keeps closed positions, whose history can no longer change.
 */
export async function readLockHistory(
  provider: AbstractProvider,
  poolsAddress: string,
  rows: LineageRow[],
  currentEpoch: number,
  cache?: Map<string, LockHistory>,
): Promise<Map<number, LockHistory>> {
  const key = (id: number) => `${poolsAddress.toLowerCase()}:${id}`;
  const out = new Map<number, LockHistory>();
  const pending = rows.filter(row => {
    const hit = row.closedAtEpoch !== 0 ? cache?.get(key(row.id)) : undefined;
    if (hit) out.set(row.id, hit);
    return !hit;
  });
  if (pending.length === 0) return out;

  const first = await multicallRead(provider, pending.flatMap(row => [
    { target: poolsAddress, iface: POOLS_IFACE, method: 'positionWithdrawableEpoch', args: [row.id] },
    { target: poolsAddress, iface: POOLS_IFACE, method: 'positionPowerSegmentAt', args: [row.id, row.stakeStartEpoch] },
  ]));
  interface Walk { row: LineageRow; restructured: boolean; epoch: number; locked: boolean; reset: number | null; done: boolean; failed: boolean }
  // Checkpoints are only written up to the next epoch (or a later activation epoch).
  const lastEpoch = (row: LineageRow) => Math.max(currentEpoch + 1, row.stakeStartEpoch);
  const step = (walk: Walk, segment: unknown[] | null) => {
    if (!segment) { walk.failed = true; walk.done = true; return; }
    const locked = (segment[1] as bigint) !== 0n;
    if (walk.locked && !locked) walk.reset = walk.epoch;
    walk.locked = locked;
    const next = segment[2] as bigint;
    const close = walk.row.closedAtEpoch;
    if (next > BigInt(lastEpoch(walk.row)) || (close !== 0 && next >= BigInt(close))) walk.done = true;
    else walk.epoch = Number(next);
  };
  const walks: Walk[] = pending.map((row, index) => {
    const withdrawable = first[2 * index]?.[0];
    const walk: Walk = { row, restructured: false, epoch: row.stakeStartEpoch, locked: false, reset: null, done: false, failed: withdrawable == null };
    if (withdrawable != null) walk.restructured = Number(withdrawable) !== 0;
    step(walk, first[2 * index + 1] ?? null);
    return walk;
  });
  for (let round = 0; round < MAX_SEGMENT_ROUNDS; round++) {
    const open = walks.filter(walk => !walk.done);
    if (open.length === 0) break;
    const segments = await multicallRead(provider, open.map(walk => ({
      target: poolsAddress, iface: POOLS_IFACE, method: 'positionPowerSegmentAt', args: [walk.row.id, walk.epoch],
    })), { assumeDeployed: true });
    open.forEach((walk, index) => step(walk, segments[index] ?? null));
  }
  for (const walk of walks) {
    if (walk.failed || !walk.done) continue;
    const history: LockHistory = { restructured: walk.restructured, maxLockResetEpoch: walk.reset, maxLocked: walk.locked };
    out.set(walk.row.id, history);
    if (walk.row.closedAtEpoch !== 0) cache?.set(key(walk.row.id), history);
  }
  return out;
}

/**
 * Normal lock start for each of `ids`, rebuilt from indexer lineage and the
 * pool's checkpoints. Any read failure leaves the affected ids `null`.
 */
export async function normalLockStarts(
  provider: AbstractProvider,
  poolsAddress: string,
  ids: number[],
  lineage: LineageRow[],
  currentEpoch: number,
  cache?: Map<string, LockHistory>,
): Promise<Map<number, number | null>> {
  const rows = new Map(lineage.map(row => [row.id, row]));
  const sources = restructureSources(lineage);
  const needed = lineageIds(ids, sources).map(id => rows.get(id)).filter((row): row is LineageRow => row !== undefined);
  let history = new Map<number, LockHistory>();
  try { history = await readLockHistory(provider, poolsAddress, needed, currentEpoch, cache); }
  catch { /* Unknown history: every start stays null and callers fall back to the public window. */ }
  return resolveNormalStarts(ids, rows, sources, history);
}
