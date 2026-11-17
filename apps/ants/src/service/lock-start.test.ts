import { beforeEach, describe, expect, it, vi } from 'vitest';
import { multicallRead, projectedEarlyExitSlashBps } from '@antseed/node/payments';
import { normalLockStarts, readLockHistory, resolveNormalStarts, restructureSources, startCandidates, type LineageRow, type LockHistory } from './lock-start.js';
import { mergeLockStartProblem, MERGE_LOCK_START_MISMATCH } from '../position-actions.js';

vi.mock('@antseed/node/payments', async original => ({ ...await original<object>(), multicallRead: vi.fn() }));

const POOLS = '0x0000000000000000000000000000000000000001';
const provider = {} as never;
const config = { maxSlashBps: 5_000, minEarlyExitSlashBps: 500 };
const fresh: LockHistory = { restructured: false, maxLockResetEpoch: null, maxLocked: false };
const restructured: LockHistory = { restructured: true, maxLockResetEpoch: null, maxLocked: false };

/**
 * Issue #1390 on Base mainnet, scaled down: A is a merge of 2 positions staked
 * at epoch 3; B is a merge of 2 older positions staked at epoch 1, then
 * extended. Both read public start 5 and end 13.
 */
function issueLineage(): { rows: LineageRow[]; history: Map<number, LockHistory> } {
  const rows: LineageRow[] = [
    { id: 1, stakeStartEpoch: 1, closedAtEpoch: 5, closedBy: 'merge', replacementIds: [5] },
    { id: 2, stakeStartEpoch: 1, closedAtEpoch: 5, closedBy: 'merge', replacementIds: [5] },
    { id: 3, stakeStartEpoch: 3, closedAtEpoch: 5, closedBy: 'merge', replacementIds: [6] },
    { id: 4, stakeStartEpoch: 3, closedAtEpoch: 5, closedBy: 'merge', replacementIds: [6] },
    { id: 5, stakeStartEpoch: 5, closedAtEpoch: 0 },
    { id: 6, stakeStartEpoch: 5, closedAtEpoch: 0 },
  ];
  const history = new Map<number, LockHistory>([[1, fresh], [2, fresh], [3, fresh], [4, fresh], [5, restructured], [6, restructured]]);
  return { rows, history };
}

describe('normal lock start', () => {
  it('inherits the originals\' start through merges, so equal public windows can still differ (#1390)', () => {
    const { rows, history } = issueLineage();
    const starts = resolveNormalStarts([5, 6], new Map(rows.map(row => [row.id, row])), restructureSources(rows), history);
    expect(starts).toEqual(new Map([[5, 1], [6, 3]]));
    const positionB = { id: 5, stakeStartEpoch: 5, stakeEndEpoch: 13, normalStartEpoch: starts.get(5) };
    const positionA = { id: 6, stakeStartEpoch: 5, stakeEndEpoch: 13, normalStartEpoch: starts.get(6) };
    // Before: the public window matched, so the dialog offered the merge the pool refuses.
    expect(mergeLockStartProblem([{ ...positionA, normalStartEpoch: undefined }, { ...positionB, normalStartEpoch: undefined }])).toBeNull();
    // After: the rebuilt start blocks it with a reason.
    expect(mergeLockStartProblem([positionA, positionB])).toBe(MERGE_LOCK_START_MISMATCH);
  });

  it('follows split and move chains and lets a max-lock disable reset the start', () => {
    const rows: LineageRow[] = [
      { id: 1, stakeStartEpoch: 2, closedAtEpoch: 6, closedBy: 'split', replacementIds: [2, 3] },
      { id: 2, stakeStartEpoch: 6, closedAtEpoch: 9, closedBy: 'move', replacementIds: [4] },
      { id: 3, stakeStartEpoch: 6, closedAtEpoch: 0 },
      { id: 4, stakeStartEpoch: 9, closedAtEpoch: 0 },
      { id: 7, stakeStartEpoch: 2, closedAtEpoch: 0 },
    ];
    const history = new Map<number, LockHistory>([
      [1, fresh], [2, restructured], [3, restructured], [4, restructured],
      [7, { restructured: false, maxLockResetEpoch: 20, maxLocked: false }],
    ]);
    expect(resolveNormalStarts([3, 4, 7], new Map(rows.map(row => [row.id, row])), restructureSources(rows), history))
      .toEqual(new Map([[3, 2], [4, 2], [7, 20]]));
  });

  it('keeps the start an ambiguous source shares with the other merge sources', () => {
    // 1 may have been reset at 9 or kept 4; 2 started at 9. The pool merged them, so they shared 9.
    const rows: LineageRow[] = [
      { id: 1, stakeStartEpoch: 4, closedAtEpoch: 12, closedBy: 'merge', replacementIds: [3] },
      { id: 2, stakeStartEpoch: 9, closedAtEpoch: 12, closedBy: 'merge', replacementIds: [3] },
      { id: 3, stakeStartEpoch: 12, closedAtEpoch: 0 },
      { id: 4, stakeStartEpoch: 12, closedAtEpoch: 0 },
    ];
    const history = new Map<number, LockHistory>([
      [1, { ...fresh, possibleResets: [9] }], [2, fresh], [3, restructured], [4, { ...fresh, possibleResets: [20] }],
    ]);
    expect(startCandidates([1, 3, 4], new Map(rows.map(row => [row.id, row])), restructureSources(rows), history))
      .toEqual(new Map([[1, [4, 9]], [3, [9]], [4, [12, 20]]]));
    expect(resolveNormalStarts([1, 3, 4], new Map(rows.map(row => [row.id, row])), restructureSources(rows), history))
      .toEqual(new Map([[1, null], [3, 9], [4, null]]));
  });

  it('stays unknown instead of guessing when the originals are not in this wallet\'s history', () => {
    const rows: LineageRow[] = [{ id: 9, stakeStartEpoch: 12, closedAtEpoch: 0 }, { id: 10, stakeStartEpoch: 12, closedAtEpoch: 0 }];
    const history = new Map<number, LockHistory>([[9, restructured], [10, fresh]]);
    const starts = resolveNormalStarts([9, 10], new Map(rows.map(row => [row.id, row])), restructureSources(rows), history);
    expect(starts).toEqual(new Map([[9, null], [10, 12]]));
    expect(mergeLockStartProblem([{ normalStartEpoch: starts.get(9) }, { normalStartEpoch: starts.get(10) }])).toBeNull();
  });
});

describe('early-exit preview from the normal lock start', () => {
  const merged = { id: 1, owner: '', agentId: 1, amount: 100n, weightAmount: 100n, stakeStartEpoch: 30, stakeEndEpoch: 114, closedAtEpoch: 0, withdrawn: false };
  const unMaxLocked = { ...merged, stakeStartEpoch: 10, stakeEndEpoch: 144 };

  it('matches the pool after a merge (the public window overstated the burn)', () => {
    // Normal window 10 -> 114, merged at 30, withdraw at 40: 74/104 of max, not 74/84.
    expect(projectedEarlyExitSlashBps(merged, 40, config)).toBe(4404);
    expect(projectedEarlyExitSlashBps(merged, 40, config, false, 10)).toBe(3557);
  });

  it('matches the pool after a max-lock disable (the public window understated the burn)', () => {
    // Staked at 10, max lock disabled effective 40 -> end 144, withdraw at 50: 94/104, not 94/134.
    expect(projectedEarlyExitSlashBps(unMaxLocked, 50, config)).toBe(3507);
    expect(projectedEarlyExitSlashBps(unMaxLocked, 50, config, false, 40)).toBe(4519);
  });

  it('keeps the pool\'s clamps and max-lock rule', () => {
    expect(projectedEarlyExitSlashBps(merged, 113, config, false, 10)).toBe(500);
    expect(projectedEarlyExitSlashBps(merged, 114, config, false, 10)).toBe(0);
    expect(projectedEarlyExitSlashBps(merged, 40, config, true, 10)).toBe(5000);
  });
});

/** The pool's epoch the mocked chain reports; `startsAt` keeps it equal to the epoch passed in. */
let chainEpoch = 0;
const startsAt = (ids: number[], rows: LineageRow[], epoch: number, cache?: Map<string, LockHistory>, config?: Parameters<typeof normalLockStarts>[6]) => {
  chainEpoch = epoch;
  return normalLockStarts(provider, POOLS, ids, rows, epoch, cache, config);
};

describe('lock history reads', () => {
  const UINT_MAX = 2n ** 256n - 1n;
  beforeEach(() => { vi.mocked(multicallRead).mockReset(); });

  it('detects restructured positions and max-lock disables from pool checkpoints, caching closed ones', async () => {
    // Position 1: fresh, extended at 8. Position 2: restructured, max locked at 6, disabled at 9. Position 3: closed fresh.
    const segments: Record<number, Array<[number, [bigint, bigint, bigint]]>> = {
      1: [[4, [10n, 0n, 8n]], [8, [20n, 0n, UINT_MAX]]],
      2: [[5, [12n, 0n, 6n]], [6, [0n, 100n, 9n]], [9, [113n, 0n, UINT_MAX]]],
      3: [[2, [9n, 0n, 7n]]],
    };
    vi.mocked(multicallRead).mockImplementation(async (_provider, requests) => requests.map(request => {
      if (request.method === 'currentEpoch') return [BigInt(chainEpoch)];
      const [id, epoch] = request.args as [number, number];
      if (request.method === 'positionWithdrawableEpoch') return [id === 2 ? 5n : 0n];
      const hit = [...segments[id]!].reverse().find(([at]) => at <= epoch)!;
      return hit[1];
    }));
    const cache = new Map<string, LockHistory>();
    const rows: LineageRow[] = [
      { id: 1, stakeStartEpoch: 4, closedAtEpoch: 0 },
      { id: 2, stakeStartEpoch: 5, closedAtEpoch: 0 },
      { id: 3, stakeStartEpoch: 2, closedAtEpoch: 7 },
    ];
    const history = await readLockHistory(provider, POOLS, rows, 10, cache);
    expect(history.get(1)).toEqual({ restructured: false, maxLockResetEpoch: null, maxLocked: false, slashEndEpoch: 20 });
    expect(history.get(2)).toEqual({ restructured: true, maxLockResetEpoch: 9, maxLocked: false, slashEndEpoch: 113 });
    expect(history.get(3)).toEqual({ restructured: false, maxLockResetEpoch: null, maxLocked: false });
    expect([...cache.keys()]).toEqual([`${POOLS}:3`]);

    vi.mocked(multicallRead).mockClear();
    await readLockHistory(provider, POOLS, [rows[2]!], 10, cache);
    expect(multicallRead).not.toHaveBeenCalled();
  });

  it('resolves a max-lock disable that takes effect in the same epoch as a split', async () => {
    // Position 1: staked at 2, max locked at 4, then max lock disabled and the position split in one
    // epoch (the flow the pool documents): both take effect at 7, so the parts start their normal lock at 7.
    const segments: Record<number, Array<[number, [bigint, bigint, bigint]]>> = {
      1: [[2, [10n, 0n, 4n]], [4, [0n, 100n, 7n]], [7, [0n, 0n, 7n]]],
      2: [[7, [111n, 0n, UINT_MAX]]],
      3: [[7, [111n, 0n, UINT_MAX]]],
    };
    vi.mocked(multicallRead).mockImplementation(async (_provider, requests) => requests.map(request => {
      if (request.method === 'currentEpoch') return [BigInt(chainEpoch)];
      const [id, epoch] = request.args as [number, number];
      if (request.method === 'positionWithdrawableEpoch') return [id === 1 ? 0n : 7n];
      return [...segments[id]!].reverse().find(([at]) => at <= epoch)![1];
    }));
    const rows: LineageRow[] = [
      { id: 1, stakeStartEpoch: 2, closedAtEpoch: 7, closedBy: 'split', replacementIds: [2, 3] },
      { id: 2, stakeStartEpoch: 7, closedAtEpoch: 0 },
      { id: 3, stakeStartEpoch: 7, closedAtEpoch: 0 },
    ];
    expect(await startsAt([2, 3], rows, 6)).toEqual(new Map([[2, 7], [3, 7]]));
  });

  /**
   * Position 1: staked at 4, ends 20, moved at 6 to position 2 (inherits start 4). Position 3: the same,
   * moved at 6 to position 4. Position 5: a fresh max-length stake at 5. At epoch 10 the pool sees:
   *   position 2: an unlocked checkpoint at 9 that moves the end to 9 + 104;
   *   position 4: created at 6 with end 6 + 104.
   * Max lock enabled and disabled within one epoch (start reset to that epoch) and an extend to the cap
   * (start kept) both leave exactly that, so each has two candidate starts; the pool's
   * `earlyExitSlashBps` tells them apart.
   */
  const toggleSegments: Record<number, Array<[number, [bigint, bigint, bigint]]>> = {
    1: [[4, [20n, 0n, 6n]], [6, [0n, 0n, 6n]]],
    2: [[6, [20n, 0n, 9n]], [9, [113n, 0n, UINT_MAX]]],
    3: [[4, [20n, 0n, 6n]], [6, [0n, 0n, 6n]]],
    4: [[6, [110n, 0n, UINT_MAX]]],
    5: [[5, [109n, 0n, UINT_MAX]]],
  };
  const toggleRows: LineageRow[] = [
    { id: 1, stakeStartEpoch: 4, closedAtEpoch: 6, closedBy: 'move', replacementIds: [2] },
    { id: 2, stakeStartEpoch: 6, closedAtEpoch: 0 },
    { id: 3, stakeStartEpoch: 4, closedAtEpoch: 6, closedBy: 'move', replacementIds: [4] },
    { id: 4, stakeStartEpoch: 6, closedAtEpoch: 0 },
    { id: 5, stakeStartEpoch: 5, closedAtEpoch: 0 },
  ];
  const poolConfig = { ...config, maxStakeEpochs: 104 };
  /** Mock pool at `epoch`: checkpoints from `segments`, `earlyExitSlashBps` from `slash` (missing = revert). */
  const mockPool = (segments: typeof toggleSegments, slash: Record<number, number | undefined>) => {
    vi.mocked(multicallRead).mockImplementation(async (_provider, requests) => requests.map(request => {
      if (request.method === 'currentEpoch') return [BigInt(chainEpoch)];
      const [id, epoch] = request.args as [number, number];
      if (request.method === 'positionWithdrawableEpoch') return [id === 2 || id === 4 ? 6n : 0n];
      if (request.method === 'earlyExitSlashBps') return slash[id] === undefined ? null : [BigInt(slash[id]!)];
      return [...segments[id]!].reverse().find(([at]) => at <= epoch)![1];
    }));
  };
  const slashReads = () => vi.mocked(multicallRead).mock.calls.flatMap(([, requests]) => requests).filter(request => request.method === 'earlyExitSlashBps');

  it('resolves max lock enabled and disabled within one epoch to the reset epoch with the pool\'s slash', async () => {
    // Pool truth: 2 starts at 9 (end 113), 4 at 6 (end 110). Withdrawing at 10 burns 103/104 and 100/104 of max.
    mockPool(toggleSegments, { 2: Math.floor(5_000 * 103 / 104), 4: Math.floor(5_000 * 100 / 104) });
    expect(await startsAt([2, 4, 5], toggleRows, 10, undefined, poolConfig)).toEqual(new Map([[2, 9], [4, 6], [5, 5]]));
    // Only the two ambiguous positions need the pool's slash, in one batched read.
    expect(slashReads().map(request => request.args![0])).toEqual([2, 4]);
    expect(vi.mocked(multicallRead).mock.calls.filter(([, requests]) => requests.some(request => request.method === 'earlyExitSlashBps'))).toHaveLength(1);
  });

  it('resolves an extend to the cap to the start it kept', async () => {
    // Pool truth: 2 keeps start 4 (end 113), 4 keeps start 4 (end 110).
    mockPool(toggleSegments, { 2: Math.floor(5_000 * 103 / 109), 4: Math.floor(5_000 * 100 / 106) });
    expect(await startsAt([2, 4], toggleRows, 10, undefined, poolConfig)).toEqual(new Map([[2, 4], [4, 4]]));
  });

  it('leaves an ambiguous start unknown when the pool\'s slash cannot decide', async () => {
    // The slash read reverts (a change still pending), or matches neither candidate.
    mockPool(toggleSegments, { 2: undefined, 4: 1234 });
    expect(await startsAt([2, 4], toggleRows, 10, undefined, poolConfig)).toEqual(new Map([[2, null], [4, null]]));
    // Near the end both candidates clamp to the minimum slash; after it both are 0.
    mockPool(toggleSegments, { 2: 500, 4: 0 });
    expect(await startsAt([2, 4], toggleRows, 112, undefined, poolConfig)).toEqual(new Map([[2, null], [4, null]]));
    // Without the pool's config there is nothing to compare: unknown, and no slash read.
    vi.mocked(multicallRead).mockClear();
    expect(await startsAt([2, 4, 5], toggleRows, 10)).toEqual(new Map([[2, null], [4, null], [5, 5]]));
    expect(slashReads()).toHaveLength(0);
  });

  it('does not read the slash while the ambiguous change is still pending', async () => {
    // Epoch 8: the checkpoint at 9 takes effect next epoch, so the pool's slash still describes the old lock.
    mockPool(toggleSegments, { 2: Math.floor(5_000 * 12 / 16) });
    expect(await startsAt([2], toggleRows, 8, undefined, poolConfig)).toEqual(new Map([[2, null]]));
    expect(slashReads()).toHaveLength(0);
  });

  it('stops at once on a position the chain closed but the feed still shows open', async () => {
    // Closed at 7 on chain; the feed row still says open, so the view keeps answering "closed at 7".
    vi.mocked(multicallRead).mockImplementation(async (_provider, requests) => requests.map(request => {
      if (request.method === 'currentEpoch') return [BigInt(chainEpoch)];
      const [, epoch] = request.args as [number, number];
      if (request.method === 'positionWithdrawableEpoch') return [0n];
      return epoch >= 7 ? [0n, 0n, 7n] : [20n, 0n, 7n];
    }));
    const rows: LineageRow[] = [{ id: 1, stakeStartEpoch: 4, closedAtEpoch: 0 }];
    expect(await startsAt([1], rows, 10)).toEqual(new Map([[1, null]]));
    expect(vi.mocked(multicallRead).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('leaves every start unknown when the epoch passed in is no longer the pool\'s', async () => {
    // A cached epoch right after a boundary: the walk and the pool's slash would read another epoch's lock.
    vi.mocked(multicallRead).mockImplementation(async (_provider, requests) => requests.map(request => {
      if (request.method === 'currentEpoch') return [BigInt(chainEpoch)];
      if (request.method === 'positionWithdrawableEpoch') return [0n];
      return [20n, 0n, 2n ** 256n - 1n];
    }));
    const rows: LineageRow[] = [{ id: 1, stakeStartEpoch: 4, closedAtEpoch: 0 }];
    expect(await startsAt([1], rows, 10)).toEqual(new Map([[1, 4]]));
    chainEpoch = 11;
    expect(await normalLockStarts(provider, POOLS, [1], rows, 10)).toEqual(new Map([[1, null]]));
  });

  it('leaves starts unknown when the chain read fails', async () => {
    vi.mocked(multicallRead).mockRejectedValue(new Error('RPC unavailable'));
    const { rows } = issueLineage();
    expect(await startsAt([5, 6], rows, 10)).toEqual(new Map([[5, null], [6, null]]));
  });
});
