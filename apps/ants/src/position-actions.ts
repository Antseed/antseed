export type PositionAction = 'split' | 'move' | 'merge' | 'extend' | 'enable-max-lock' | 'disable-max-lock';

interface ActionPosition {
  stakeStartEpoch: number;
  stakeEndEpoch: number;
  closedAtEpoch: number;
  withdrawn: boolean;
  maxLocked: boolean;
  maxLockedNext?: boolean;
}

export function scheduledMaxLock(position: Pick<ActionPosition, 'maxLocked' | 'maxLockedNext'>): boolean {
  return position.maxLockedNext ?? position.maxLocked;
}

export function positionActionEpoch(action: PositionAction, currentEpoch: number, positions: Pick<ActionPosition, 'stakeStartEpoch'>[]): number {
  if (action === 'enable-max-lock' || action === 'disable-max-lock') return currentEpoch + 1;
  return Math.max(currentEpoch + 1, ...positions.map(position => position.stakeStartEpoch));
}

export function positionActionProblem(position: ActionPosition, action: PositionAction, effectiveEpoch: number | null): string | null {
  if (position.withdrawn || position.closedAtEpoch !== 0) return 'This position is already closed or withdrawn.';
  if (effectiveEpoch === null) return 'Waiting for current epoch information.';
  const locked = scheduledMaxLock(position);
  if (action === 'disable-max-lock') return locked ? null : 'This position is not scheduled for max lock.';
  if (locked) return action === 'enable-max-lock' ? 'This position is already scheduled for max lock.' : 'Disable maximum lock before this action.';
  if (action === 'enable-max-lock' && effectiveEpoch < position.stakeStartEpoch) return `Max lock can be enabled when the next epoch reaches activation epoch ${position.stakeStartEpoch}.`;
  if (position.stakeEndEpoch === 0 || effectiveEpoch >= position.stakeEndEpoch) return 'The position has no remaining lock when this action takes effect. Withdraw it, then stake again to start a new lock.';
  return null;
}

export const MERGE_LOCK_START_MISMATCH = 'These positions started their locks at different epochs, so they can\'t be merged. Matching unlock dates are not enough: split, merged and moved positions keep the lock start of the originals.';

/**
 * The pool merges only positions with the same normal lock start, which split,
 * merge and move inherit from the originals (so it can differ from the public
 * start). Returns the reason when two known starts differ; unknown starts are
 * left to the pre-signing simulation.
 */
export function mergeLockStartProblem(positions: Array<{ normalStartEpoch?: number | null }>): string | null {
  const known = positions.map(position => position.normalStartEpoch).filter((start): start is number => typeof start === 'number');
  return new Set(known).size > 1 ? MERGE_LOCK_START_MISMATCH : null;
}

/** What the pool requires of an allowed merge, naming the shared lock start when every one is known. */
export function mergeRuleHint(positions: Array<{ normalStartEpoch?: number | null }>): string {
  const starts = positions.map(position => position.normalStartEpoch);
  const shared = starts.length > 0 && starts.every(start => typeof start === 'number' && start === starts[0]) ? starts[0] : null;
  return shared != null
    ? `They share the seller, the unlock date and the lock start (epoch ${shared}).`
    : 'Positions merge only when they share the seller, the unlock date and the lock start; the lock start is checked before you sign.';
}
