import { beforeEach, describe, expect, it, vi } from 'vitest';
import { multicallRead, projectedEarlyExitSlashBps } from '@antseed/node/payments';
import { earlyExitSlashBpsFrom, normalLockStarts, readLockHistory, resolveNormalStarts, restructureSources, type LineageRow, type LockHistory } from './lock-start.js';
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
    expect(earlyExitSlashBpsFrom(merged, 10, 40, config)).toBe(3557);
  });

  it('matches the pool after a max-lock disable (the public window understated the burn)', () => {
    // Staked at 10, max lock disabled effective 40 -> end 144, withdraw at 50: 94/104, not 94/134.
    expect(projectedEarlyExitSlashBps(unMaxLocked, 50, config)).toBe(3507);
    expect(earlyExitSlashBpsFrom(unMaxLocked, 40, 50, config)).toBe(4519);
  });

  it('keeps the pool\'s clamps and max-lock rule', () => {
    expect(earlyExitSlashBpsFrom(merged, 10, 113, config)).toBe(500);
    expect(earlyExitSlashBpsFrom(merged, 10, 114, config)).toBe(0);
    expect(earlyExitSlashBpsFrom(merged, 10, 40, config, true)).toBe(5000);
  });
});

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
    expect(history.get(1)).toEqual({ restructured: false, maxLockResetEpoch: null, maxLocked: false });
    expect(history.get(2)).toEqual({ restructured: true, maxLockResetEpoch: 9, maxLocked: false });
    expect(history.get(3)).toEqual({ restructured: false, maxLockResetEpoch: null, maxLocked: false });
    expect([...cache.keys()]).toEqual([`${POOLS}:3`]);

    vi.mocked(multicallRead).mockClear();
    await readLockHistory(provider, POOLS, [rows[2]!], 10, cache);
    expect(multicallRead).not.toHaveBeenCalled();
  });

  it('leaves starts unknown when the chain read fails', async () => {
    vi.mocked(multicallRead).mockRejectedValue(new Error('RPC unavailable'));
    const { rows } = issueLineage();
    expect(await normalLockStarts(provider, POOLS, [5, 6], rows, 10)).toEqual(new Map([[5, null], [6, null]]));
  });
});
