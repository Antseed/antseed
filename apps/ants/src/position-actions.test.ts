import { describe, expect, it } from 'vitest';
import { positionActionEpoch, positionActionProblem, type PositionAction } from './position-actions.js';

const position = { stakeStartEpoch: 26, stakeEndEpoch: 130, closedAtEpoch: 0, withdrawn: false, maxLocked: false, maxLockedNext: false };

describe('position action eligibility', () => {
  it.each<PositionAction>(['split', 'move', 'merge', 'extend', 'enable-max-lock'])('permits %s on a next-epoch split replacement', action => {
    expect(positionActionProblem(position, action, positionActionEpoch(action, 25, [position]))).toBeNull();
  });

  it.each<PositionAction>(['split', 'move', 'merge', 'extend'])('evaluates %s at activation, not the current epoch', action => {
    const future = { ...position, stakeStartEpoch: 28 };
    expect(positionActionEpoch(action, 25, [future])).toBe(28);
    expect(positionActionProblem(future, action, 28)).toBeNull();
    expect(positionActionProblem({ ...future, maxLocked: true, maxLockedNext: false }, action, 28)).toBeNull();
    expect(positionActionProblem({ ...future, maxLockedNext: true }, action, 28)).toContain('Disable maximum lock');
  });

  it('uses the latest source activation for a merge', () => {
    expect(positionActionEpoch('merge', 25, [position, { stakeStartEpoch: 29 }])).toBe(29);
  });

  it('does not activate max lock before a delayed position starts', () => {
    const future = { ...position, stakeStartEpoch: 28 };
    expect(positionActionEpoch('enable-max-lock', 25, [future])).toBe(26);
    expect(positionActionProblem(future, 'enable-max-lock', 26)).toContain('activation epoch 28');
  });

  it('allows reversing a scheduled max lock without waiting for activation', () => {
    expect(positionActionProblem({ ...position, maxLockedNext: true }, 'disable-max-lock', 26)).toBeNull();
    expect(positionActionProblem({ ...position, maxLockedNext: true }, 'enable-max-lock', 26)).toContain('already scheduled');
    expect(positionActionProblem(position, 'disable-max-lock', 26)).toContain('not scheduled');
  });

  it.each<PositionAction>(['split', 'move', 'merge', 'extend', 'enable-max-lock', 'disable-max-lock'])('rejects closed positions for %s', action => {
    expect(positionActionProblem({ ...position, closedAtEpoch: 26 }, action, 26)).toContain('closed');
    expect(positionActionProblem({ ...position, withdrawn: true }, action, 26)).toContain('withdrawn');
  });

  it.each<PositionAction>(['split', 'move', 'merge', 'extend', 'enable-max-lock'])('requires remaining lock at the effective epoch for %s', action => {
    expect(positionActionProblem({ ...position, stakeEndEpoch: 26 }, action, 26)).toContain('remaining lock');
  });

  it('waits for epoch data instead of assuming an action is valid', () => {
    expect(positionActionProblem(position, 'split', null)).toContain('epoch information');
  });
});
