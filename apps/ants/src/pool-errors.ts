import { Interface } from 'ethers';

/** The seller pools contract's custom errors (`IAntseedSellerPools`). */
const POOL_ERRORS = new Interface([
  'error InvalidAddress()',
  'error InvalidValue()',
  'error InvalidPosition()',
  'error NotPositionOwner()',
  'error StakeDurationOutOfBounds()',
  'error PositionClosed()',
  'error PositionChangePending()',
  'error AlreadyWithdrawn()',
  'error NotRewardStaker()',
]);

export type PoolAction = 'merge' | 'withdraw' | 'split' | 'move' | 'extend' | 'max-lock' | 'stake';

const MESSAGES: Record<string, string> = {
  InvalidAddress: 'The pool rejected an empty address.',
  InvalidValue: 'The pool rejected one of the values in this request.',
  InvalidPosition: 'The position does not exist.',
  NotPositionOwner: 'This wallet does not own the position.',
  StakeDurationOutOfBounds: 'The lock length is outside the allowed range, or the lock has already ended.',
  PositionClosed: 'The position is closed, withdrawn or max locked. Disable max lock first if it is on.',
  PositionChangePending: 'The position changed this epoch. Try again after the next epoch boundary.',
  AlreadyWithdrawn: 'The position has already been withdrawn.',
  NotRewardStaker: 'This caller may not stake rewards.',
};

const ACTION_MESSAGES: Partial<Record<PoolAction, Record<string, string>>> = {
  merge: {
    // mergeStakes reuses InvalidValue for "different pool" and for "different lock start or end".
    InvalidValue: 'These positions started their locks at different epochs, end at different epochs or stake different sellers, so they can\'t be merged.',
  },
};

const HEX = /^0x[0-9a-fA-F]*$/;

/** Revert data from an ethers, viem or JSON-RPC error, wherever the library nested it. */
function revertData(error: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || value === undefined || seen.has(value)) return;
    if (typeof value === 'string') {
      if (HEX.test(value) && value.length >= 10) found.push(value);
      for (const match of value.matchAll(/0x[0-9a-fA-F]{8,}/g)) found.push(match[0]);
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ['data', 'error', 'info', 'cause', 'revert', 'message', 'shortMessage', 'details']) visit(record[key], depth + 1);
  };
  visit(error, 0);
  return found;
}

/** The pool custom error name in `error`, if any. */
export function poolErrorName(error: unknown): string | null {
  for (const data of revertData(error)) {
    try {
      const parsed = POOL_ERRORS.parseError(data.slice(0, 10));
      if (parsed) return parsed.name;
    } catch { /* not a pool error selector */ }
  }
  return null;
}

/** A readable sentence for a pool custom error revert, or null when `error` is not one. */
export function poolRevertMessage(error: unknown, action?: PoolAction): string | null {
  const name = poolErrorName(error);
  if (!name) return null;
  return (action ? ACTION_MESSAGES[action]?.[name] : undefined) ?? MESSAGES[name] ?? null;
}
