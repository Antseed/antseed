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
 * guess. Enabling and disabling max lock within one epoch also resets the
 * start but leaves no max-lock power checkpoint, and reads like an extend to
 * the cap. Such a position keeps both candidate starts, and the pool's own
 * `earlyExitSlashBps` picks the one whose slash it charges; when the slash
 * cannot tell them apart the start stays unknown.
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
  /**
   * Epochs after the known start where max lock may have been enabled and disabled within one epoch:
   * that resets the start to the epoch and moves the end to epoch + max with no max-lock power left,
   * and an extend to the cap reads the same. Each is a candidate start beside the known one.
   */
  possibleResets?: number[];
  /** Open positions: the normal end at the epoch the pool's `earlyExitSlashBps` reads. */
  slashEndEpoch?: number;
}

/** What `normalLockStarts` needs from the pool's config to match its early-exit slash. */
export type LockStartConfig = Pick<SellerPoolConfig, 'maxStakeEpochs' | 'maxSlashBps' | 'minEarlyExitSlashBps'>;

/** The pool's `earlyExitSlashBps` at `epoch` for some open positions, to choose between candidate starts. */
export interface PoolSlash {
  epoch: number;
  config: Pick<SellerPoolConfig, 'maxSlashBps' | 'minEarlyExitSlashBps'>;
  bps: Map<number, number>;
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
 * Candidate normal lock starts per id, or null when the history needed to
 * know them is missing (a restructured position whose sources this wallet
 * never held, or a position whose history could not be read). More than one
 * candidate means a max-lock toggle that reads like an extend to the cap, here
 * or in an ancestor.
 */
export function startCandidates(
  ids: number[],
  rows: Map<number, LineageRow>,
  sources: Map<number, number[]>,
  history: Map<number, LockHistory>,
): Map<number, number[] | null> {
  const resolved = new Map<number, number[] | null>();
  const resolve = (id: number, depth: number): number[] | null => {
    if (resolved.has(id)) return resolved.get(id)!;
    const row = rows.get(id);
    const lock = history.get(id);
    let known: number[] | null = null;
    if (row && lock && !lock.maxLocked && depth < 256) {
      if (lock.maxLockResetEpoch !== null) known = [lock.maxLockResetEpoch];
      else if (!lock.restructured) known = [row.stakeStartEpoch];
      else {
        // Split and move have one source. Merge sources shared one start (the pool refuses otherwise),
        // so it is in every source's candidates.
        const inherited = (sources.get(id) ?? []).map(source => resolve(source, depth + 1));
        if (inherited.length > 0 && inherited.every(starts => starts !== null)) {
          known = inherited.reduce((shared, starts) => shared!.filter(start => starts!.includes(start)));
        }
      }
    }
    const candidates = known && known.length > 0 ? [...new Set([...known, ...(lock?.possibleResets ?? [])])].sort((a, b) => a - b) : null;
    resolved.set(id, candidates);
    return candidates;
  };
  for (const id of ids) resolve(id, 0);
  return new Map(ids.map(id => [id, resolved.get(id) ?? null]));
}

/**
 * Normal lock start per id, or null when unknown. A position with several
 * candidate starts takes the single one whose early-exit slash equals the
 * pool's (`poolSlash`), and stays unknown otherwise.
 */
export function resolveNormalStarts(
  ids: number[],
  rows: Map<number, LineageRow>,
  sources: Map<number, number[]>,
  history: Map<number, LockHistory>,
  poolSlash?: PoolSlash,
): Map<number, number | null> {
  return chooseStarts(startCandidates(ids, rows, sources, history), rows, history, poolSlash);
}

function chooseStarts(
  candidates: Map<number, number[] | null>,
  rows: Map<number, LineageRow>,
  history: Map<number, LockHistory>,
  poolSlash?: PoolSlash,
): Map<number, number | null> {
  const choose = (id: number, starts: number[] | null): number | null => {
    if (starts === null || starts.length === 1) return starts?.[0] ?? null;
    const bps = poolSlash?.bps.get(id);
    if (bps === undefined || !slashCanDecide(starts, rows.get(id), history.get(id), poolSlash!.epoch)) return null;
    const position = { stakeStartEpoch: rows.get(id)!.stakeStartEpoch, stakeEndEpoch: history.get(id)!.slashEndEpoch! };
    const matches = starts.filter(start => earlyExitSlashBpsFrom(position, start, poolSlash!.epoch, poolSlash!.config) === bps);
    return matches.length === 1 ? matches[0]! : null;
  };
  return new Map([...candidates].map(([id, starts]) => [id, choose(id, starts)]));
}

/**
 * The pool's slash at `epoch` reads the lock in force at its close epoch. It
 * decides between candidates only for an open position whose candidates all
 * took effect by then; a reset still pending next epoch is not in it yet.
 */
function slashCanDecide(starts: number[], row: LineageRow | undefined, lock: LockHistory | undefined, epoch: number): boolean {
  if (!row || row.closedAtEpoch !== 0 || lock?.slashEndEpoch === undefined) return false;
  const closeEpoch = Math.max(epoch, row.stakeStartEpoch);
  return starts.every(start => start <= closeEpoch);
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
  'function earlyExitSlashBps(uint256 positionId) view returns (uint256)',
]);
const MAX_SEGMENT_ROUNDS = 32;
/** `AntseedSellerPools.MAX_STAKE_EPOCHS`, a contract constant. */
export const MAX_STAKE_EPOCHS = 104;

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
  maxStakeEpochs = MAX_STAKE_EPOCHS,
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
  interface Walk {
    row: LineageRow; restructured: boolean; epoch: number; locked: boolean; reset: number | null; done: boolean; failed: boolean;
    started: boolean; possibleResets: number[]; slashEnd: number | null;
  }
  // Checkpoints are only written up to the next epoch (or a later activation epoch).
  const lastEpoch = (row: LineageRow) => Math.max(currentEpoch + 1, row.stakeStartEpoch);
  // The epoch whose lock the pool's `earlyExitSlashBps` reads now.
  const closeEpoch = (row: LineageRow) => Math.max(currentEpoch, row.stakeStartEpoch);
  const step = (walk: Walk, segment: unknown[] | null) => {
    if (!segment) { walk.failed = true; walk.done = true; return; }
    const locked = (segment[1] as bigint) !== 0n;
    // Max lock enabled and disabled within this epoch resets the start to it and moves the end to
    // epoch + max, leaving the max-lock power unchanged; an extend to the cap (or a restructure that
    // inherits such an end) reads the same, so the epoch is only a possible start.
    const atMaxEnd = (segment[0] as bigint) === BigInt(walk.epoch + maxStakeEpochs);
    if (walk.started && walk.locked && !locked) { walk.reset = walk.epoch; walk.possibleResets = []; }
    else if (!walk.locked && !locked && atMaxEnd) walk.possibleResets.push(walk.epoch);
    if (walk.epoch <= closeEpoch(walk.row)) walk.slashEnd = Number(segment[0]);
    walk.started = true;
    walk.locked = locked;
    const next = segment[2] as bigint;
    const close = walk.row.closedAtEpoch;
    if (next > BigInt(lastEpoch(walk.row)) || (close !== 0 && next >= BigInt(close))) walk.done = true;
    // No progress: the chain closed a position the feed still shows open. Leave it unknown.
    else if (next <= BigInt(walk.epoch)) { walk.failed = true; walk.done = true; }
    else walk.epoch = Number(next);
  };
  const walks: Walk[] = pending.map((row, index) => {
    const withdrawable = first[2 * index]?.[0];
    const walk: Walk = { row, restructured: false, epoch: row.stakeStartEpoch, locked: false, reset: null, done: false, failed: withdrawable == null, started: false, possibleResets: [], slashEnd: null };
    if (withdrawable != null) walk.restructured = Number(withdrawable) !== 0;
    step(walk, first[2 * index + 1] ?? null);
    return walk;
  });
  for (let round = 0; round < MAX_SEGMENT_ROUNDS; round++) {
    const open = walks.filter(walk => !walk.done);
    if (open.length === 0) break;
    // No `assumeDeployed`: a chain without Multicall3 (a local Anvil) must fall back to single calls here too.
    const segments = await multicallRead(provider, open.map(walk => ({
      target: poolsAddress, iface: POOLS_IFACE, method: 'positionPowerSegmentAt', args: [walk.row.id, walk.epoch],
    })));
    open.forEach((walk, index) => step(walk, segments[index] ?? null));
  }
  for (const walk of walks) {
    if (walk.failed || !walk.done) continue;
    // The pool closes a position only when it is not max locked at the close epoch, so one still max
    // locked in its last segment had max lock disabled effective at that epoch (disable, then split,
    // merge or move in one epoch, as the pool documents).
    if (walk.locked && walk.row.closedAtEpoch !== 0) {
      walk.reset = walk.row.closedAtEpoch;
      walk.locked = false;
      walk.possibleResets = [];
    }
    const history: LockHistory = {
      restructured: walk.restructured, maxLockResetEpoch: walk.reset, maxLocked: walk.locked,
      ...(walk.possibleResets.length > 0 ? { possibleResets: walk.possibleResets } : {}),
      ...(walk.row.closedAtEpoch === 0 && walk.slashEnd !== null ? { slashEndEpoch: walk.slashEnd } : {}),
    };
    out.set(walk.row.id, history);
    if (walk.row.closedAtEpoch !== 0) cache?.set(key(walk.row.id), history);
  }
  return out;
}

/**
 * Normal lock start for each of `ids`, rebuilt from indexer lineage and the
 * pool's checkpoints. With the pool's `config`, a position with two candidate
 * starts is settled by the pool's `earlyExitSlashBps`, read in one batch for
 * just those positions. Any read failure leaves the affected ids `null`.
 */
export async function normalLockStarts(
  provider: AbstractProvider,
  poolsAddress: string,
  ids: number[],
  lineage: LineageRow[],
  currentEpoch: number,
  cache?: Map<string, LockHistory>,
  config?: LockStartConfig,
): Promise<Map<number, number | null>> {
  const rows = new Map(lineage.map(row => [row.id, row]));
  const sources = restructureSources(lineage);
  const needed = lineageIds(ids, sources).map(id => rows.get(id)).filter((row): row is LineageRow => row !== undefined);
  let history = new Map<number, LockHistory>();
  try { history = await readLockHistory(provider, poolsAddress, needed, currentEpoch, cache, config?.maxStakeEpochs); }
  catch { /* Unknown history: every start stays null and callers fall back to the public window. */ }
  const candidates = startCandidates(ids, rows, sources, history);
  let poolSlash: PoolSlash | undefined;
  if (config) {
    const slashIds = [...candidates]
      .filter(([id, starts]) => starts !== null && starts.length > 1 && slashCanDecide(starts, rows.get(id), history.get(id), currentEpoch))
      .map(([id]) => id);
    poolSlash = { epoch: currentEpoch, config, bps: new Map() };
    try {
      const read = slashIds.length === 0 ? [] : await multicallRead(provider, slashIds.map(id => ({ target: poolsAddress, iface: POOLS_IFACE, method: 'earlyExitSlashBps', args: [id] })));
      // A revert (a change pending until the position's withdrawable epoch) leaves that start unknown.
      slashIds.forEach((id, index) => { const value = read[index]?.[0]; if (value != null) poolSlash!.bps.set(id, Number(value)); });
    } catch { /* No slash: ambiguous starts stay null. */ }
  }
  return chooseStarts(candidates, rows, history, poolSlash);
}
