import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolConfigView, PoolView, PositionView } from '../../src/api-types';
import type { ActionButtonProps } from './components/Confirm';
import { LockSlider } from './components/LockSlider';
import { mergeEligibility, RowActionPanel } from './components/Positions';
import { epochStartAt, formatUtc } from './format';

const mocks = vi.hoisted(() => ({ epoch: vi.fn(), action: vi.fn(), withdrawal: vi.fn() }));
vi.mock('./app-context', () => ({ useEpochInfo: mocks.epoch }));
vi.mock('./components/Confirm', () => ({
  ActionDialog: ({ children, title }: { children: ReactNode; title: string }) => createElement('section', null, createElement('h2', null, title), children),
  ActionButton: (props: ActionButtonProps) => {
    mocks.action(props);
    return createElement('button', null, props.label);
  },
}));
vi.mock('./components/WithdrawAction', () => ({ WithdrawAction: (props: unknown) => { mocks.withdrawal(props); return null; } }));

const epoch = { current: 28, genesis: 1775728461, epochDuration: 604800 };
const dateAt = (value: number) => formatUtc(epochStartAt(value, epoch.genesis, epoch.epochDuration));

function render(stakeEndEpoch = 40, maxStakeEpochs = 104, kind: 'move' | 'extend' | 'withdraw' = 'extend') {
  return renderToStaticMarkup(createElement(RowActionPanel, {
    kind,
    position: { id: 30, agentId: 86940, amount: '200000000000000000000', stakeStartEpoch: 18, stakeEndEpoch, closedAtEpoch: 0, withdrawn: false, state: stakeEndEpoch <= epoch.current ? 'matured' : 'active', epochsRemaining: 12, maxLocked: false, maxLockedNext: false } as PositionView,
    config: { maxStakeEpochs, moveWeightPenaltyBps: 0 } as PoolConfigView,
    onClose: vi.fn(),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.epoch.mockReturnValue(epoch);
});

describe('single-position move', () => {
  function renderMove(overrides: Partial<PositionView> = {}, targets = true) {
    const pools = [
      { agentId: 86940, stakeable: true, profile: { name: 'Source seller' } },
      { agentId: 86941, stakeable: false, profile: { name: 'Unavailable seller' } },
      ...(targets ? [{ agentId: 86939, stakeable: true, profile: { name: 'Target seller' } }] : []),
    ] as PoolView[];
    const onClose = vi.fn();
    const html = renderToStaticMarkup(createElement(RowActionPanel, {
      kind: 'move',
      position: { id: 30, agentId: 86940, amount: '200000000000000000000', stakeStartEpoch: 28, stakeEndEpoch: 40, epochsRemaining: 12, maxLocked: false, changePending: false, withdrawn: false, closedAtEpoch: 0, state: 'active', ...overrides } as PositionView,
      config: { maxStakeEpochs: 104, moveWeightPenaltyBps: 0 } as PoolConfigView,
      pools,
      onClose,
    }));
    return { html, action: mocks.action.mock.calls[0]![0] as ActionButtonProps, onClose };
  }

  it('shows one source and targets only other stakeable sellers', () => {
    const { html, action, onClose } = renderMove();
    expect(html).toContain('Source seller');
    expect(html).toContain('200 ANTS');
    expect(html).toContain('Remaining lock');
    expect(html).toContain('Target seller');
    expect(html).not.toContain('Unavailable seller');
    expect(html).not.toContain('value="86940"');
    expect(action.path).toBe('/api/positions/move');
    expect(action.body).toEqual({ positionIds: [30], toAgentId: 86939 });
    expect(action.disabled).toBe(false);
    expect(action.validate?.()).toBeNull();
    expect(action.summary).toBeUndefined();
    action.onStarted?.();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    { maxLocked: true },
    { state: 'matured' as const, stakeEndEpoch: 28 },
    { withdrawn: true },
    { closedAtEpoch: 28 },
  ])('preserves move restrictions for %j', overrides => {
    const { action } = renderMove(overrides);
    expect(action.disabled).toBe(true);
    expect(action.disabledReason).toBeTruthy();
  });

  it('requires a valid destination', () => {
    const { html, action } = renderMove({}, false);
    expect(html).toContain('No other seller to move to');
    expect(action.validate?.()).toBe('Choose a target seller.');
  });

  it('allows moving before activation and after scheduling max-lock disable', () => {
    expect(renderMove({ changePending: true, state: 'pending', stakeStartEpoch: 29 }).action.disabled).toBe(false);
    mocks.action.mockClear();
    expect(renderMove({ maxLocked: true, maxLockedNext: false }).action.disabled).toBe(false);
  });
});

describe('extend position layout', () => {
  it.each([
    ['move', 'Move allocation'], ['extend', 'Extend position'], ['withdraw', 'Withdraw positions'],
  ] as const)('keeps the %s modal title free of position numbers', (kind, title) => {
    const html = render(40, 104, kind);
    expect(html).toContain(`<h2>${title}</h2>`);
    expect(html).not.toMatch(/<h2>[^<]*#30/);
  });

  it('passes just one position to withdrawal and replaces the raw pool header', () => {
    const html = render(40, 104, 'withdraw');
    expect(mocks.withdrawal.mock.calls[0]![0]).toMatchObject({ positionId: 30, autoOpen: true });
    expect(mocks.withdrawal.mock.calls[0]![0]).not.toHaveProperty('positionIds');
    expect(html).toContain('200');
    expect(html).not.toContain('Pool ');
    expect(html).not.toContain('86940');
    expect(html).not.toContain('Withdraw 1 position');
  });

  it('orders amount, current unlock, slider, epochs and the new unlock date', () => {
    const html = render();
    const markers = ['<dt>Amount</dt>', '200 ANTS', '<dt>Current unlock time</dt>', dateAt(40), 'type="range"', 'lock-slider-readout', '<dt>New unlock date</dt>', dateAt(41)];
    const offsets = markers.map(marker => html.indexOf(marker));
    expect(offsets.every(offset => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((first, second) => first - second));
    expect(html).not.toContain('ends epoch');
    expect(html).not.toContain('86940');
    expect(html).not.toContain('· unlocks');
    expect(mocks.action.mock.calls[0]![0].body).toEqual({ positionId: 30, epochs: 1 });
  });

  it('does not offer to revive an expired lock with an extension', () => {
    const html = render(20);
    expect(html).toContain(dateAt(20));
    expect(html).not.toContain(dateAt(30));
    expect(mocks.action.mock.calls[0]![0].disabled).toBe(true);
    expect(mocks.action.mock.calls[0]![0].validate()).toContain('remaining lock');
  });

  it('does not invent dates when epoch information is unavailable', () => {
    mocks.epoch.mockReturnValue(null);
    const html = render();
    expect(html).not.toContain('UTC');
    expect(html).toContain('disabled=""');
    expect(html).toContain('<dt>New unlock date</dt><dd><span class="mono">—</span></dd>');
  });

  it('does not show a new unlock date when no extension is possible', () => {
    const html = render(133);
    expect(html).toContain('disabled=""');
    expect(html).toContain('<dt>New unlock date</dt><dd><span class="mono">—</span></dd>');
  });

  it.each([1, 12, 77])('keeps the %s-epoch readout and only hides the inline date when requested', value => {
    const props = { value, max: 104, startEpoch: 40, onChange: vi.fn() };
    const normal = renderToStaticMarkup(createElement(LockSlider, props));
    const compact = renderToStaticMarkup(createElement(LockSlider, { ...props, showUnlockDate: false }));
    expect(normal).toContain('· unlocks');
    expect(compact).not.toContain('· unlocks');
    expect(compact).toContain(`<span class="mono">${value}</span>`);
    expect(compact).toContain(`aria-valuenow="${value}"`);
  });
});

describe('pending position action forms', () => {
  const pendingPosition = {
    id: 28, agentId: 1, owner: '0x0000000000000000000000000000000000000001',
    amount: '50000000000000000000', weightAmount: '50000000000000000000',
    stakeStartEpoch: 29, stakeEndEpoch: 130, closedAtEpoch: 0, withdrawn: false,
    state: 'pending', changePending: true, withdrawableEpoch: 29,
    maxLocked: false, maxLockedNext: false, epochsRemaining: 101,
  } as PositionView;

  function renderAction(kind: 'max-lock' | 'split' | 'extend' | 'withdraw', overrides: Partial<PositionView> = {}) {
    mocks.action.mockClear();
    const html = renderToStaticMarkup(createElement(RowActionPanel, {
      kind, position: { ...pendingPosition, ...overrides }, config: { maxStakeEpochs: 104 } as PoolConfigView, pools: [], onClose: vi.fn(),
    }));
    return { html, action: mocks.action.mock.calls[0]?.[0] as ActionButtonProps | undefined };
  }

  it.each(['max-lock', 'split', 'extend'] as const)('allows %s on a next-epoch split replacement', kind => {
    const { action } = renderAction(kind);
    expect(action?.disabled).toBe(false);
  });

  it('blocks premature max lock but lets a delayed position be extended', () => {
    expect(renderAction('max-lock', { stakeStartEpoch: 31 }).action?.disabled).toBe(true);
    expect(renderAction('extend', { stakeStartEpoch: 31 }).action?.disabled).toBe(false);
  });

  it('allows reversing a pending max-lock activation and warns that the old lock is not restored', () => {
    const { html, action } = renderAction('max-lock', { maxLockedNext: true });
    expect(action?.label).toBe('Disable max lock');
    expect(action?.disabled).toBe(false);
    expect(html).toContain('104-epoch countdown');
    expect(renderAction('max-lock').html).toContain('does not restore the original shorter lock');
  });

  it('allows extension after scheduled disable but not scheduled enable', () => {
    expect(renderAction('extend', { maxLocked: true, maxLockedNext: false }).action?.disabled).toBe(false);
    expect(renderAction('extend', { maxLockedNext: true }).action?.disabled).toBe(true);
  });

  it('retains the withdrawal activation warning', () => {
    expect(renderAction('withdraw').html).toContain('Withdrawals are blocked until activation epoch 29');
  });

  it('allows pending merges, but retains duplicate, closed, effective lock and end checks', () => {
    const other = { ...pendingPosition, id: 29 };
    expect(mergeEligibility([pendingPosition, other], 28)).toBeNull();
    expect(mergeEligibility([{ ...pendingPosition, maxLocked: true, maxLockedNext: false }, other], 28)).toBeNull();
    expect(mergeEligibility([pendingPosition, pendingPosition], 28)).toContain('only once');
    expect(mergeEligibility([pendingPosition, { ...other, maxLockedNext: true }], 28)).toContain('Disable maximum lock');
    expect(mergeEligibility([pendingPosition, { ...other, closedAtEpoch: 29 }], 28)).toContain('closed');
    expect(mergeEligibility([pendingPosition, { ...other, stakeEndEpoch: 131 }], 28)).toContain('same unlock epoch');
    expect(mergeEligibility([pendingPosition, { ...other, agentId: 2 }], 28)).toContain('same seller');
  });
});
