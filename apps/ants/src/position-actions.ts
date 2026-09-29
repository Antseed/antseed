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
  if (position.stakeEndEpoch === 0 || effectiveEpoch >= position.stakeEndEpoch) return 'The position must have a remaining lock when this action takes effect.';
  return null;
}
