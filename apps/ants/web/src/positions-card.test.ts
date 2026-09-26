import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolView, PositionView } from '../../src/api-types';
import { PositionSummary, PositionsCard } from './components/Positions';
import { PoolsTable } from './components/Pools';

const mocks = vi.hoisted(() => ({ page: vi.fn(), table: vi.fn(), menu: vi.fn(), epoch: vi.fn() }));
vi.mock('./data', () => ({ usePageData: mocks.page }));
vi.mock('./app-context', () => ({ useEpochInfo: mocks.epoch }));
vi.mock('./components/Menu', async original => {
  const actual = await original<typeof import('./components/Menu')>();
  return { ...actual, Menu: (props: Parameters<typeof actual.Menu>[0]) => {
    mocks.menu(props);
    return createElement(actual.Menu, props);
  } };
});
vi.mock('./components/Table', async original => {
  const actual = await original<typeof import('./components/Table')>();
  return { ...actual, Table: (props: Parameters<typeof actual.Table>[0]) => {
    mocks.table(props);
    return createElement(actual.Table, props);
  } };
});

function position(overrides: Partial<PositionView> = {}): PositionView {
  return {
    id: 29, agentId: 86939, owner: '0x148C5602f160F21E52144dC2d60E11A2C20D6ad6',
    amount: '125000000000000000000', weightAmount: '125000000000000000000',
    stakeStartEpoch: 26, stakeEndEpoch: 38, closedAtEpoch: 0, withdrawn: false,
    state: 'active', withdrawableEpoch: 27, changePending: false, maxLocked: false, maxLockedNext: false,
    slashBps: 5000, projectedSlashBps: 5000, slashedAmount: '62500000000000000000',
    returnedAmount: '62500000000000000000', pendingReward: '0', epochsRemaining: 11,
    ...overrides,
  };
}

function renderPosition(overrides: Partial<PositionView> = {}, pools: PoolView[] = []) {
  mocks.page.mockReturnValue({ data: { positions: [position(overrides)] }, loading: false, error: null });
  return renderToStaticMarkup(createElement(PositionsCard, { pools }));
}

function pool(name: string | null): PoolView {
  return {
    agentId: 86939, seller: position().owner,
    profile: { name, providers: [], modelsServed: null, uniqueBuyers: null, requestCount: null, lifetimeVolumeUsdc: null, ghostRate: null, lastSettledAt: null },
    hasPool: true, stakeable: true, activeStake: '0', weight: '0', powerShareBps: 0, securityShareBps: 0,
    volumes: [], usagePoints: '0', weightedUsagePoints: '0', lastEpochUsagePoints: '0', lastEpochEmission: null,
    lastEpochEmissionSettled: false, lastEpochRewardPer1kPower: null, projectedRewardPer1kPower: null,
    yourStake: '0', yourPendingStake: '0', yourPower: '0', yourPoolShareBps: 0, yourPositionIds: [29],
  };
}

beforeEach(() => { vi.clearAllMocks(); mocks.epoch.mockReturnValue(null); });

describe('position summary', () => {
  it('shows live power rather than the original weight and exposes next-epoch power', () => {
    const html = renderPosition({ power: '9000000000000000000', nextPower: '8000000000000000000' });
    expect(html).toContain('power 9');
    expect(html).not.toContain('power 125');
    expect(html).toContain('Next epoch power: 8');
  });
  it('shows the pending lock duration, activation date and unchanged unlock date', () => {
    mocks.epoch.mockReturnValue({ current: 27, genesis: 1775728461, epochDuration: 604800 });
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position({ state: 'pending', stakeStartEpoch: 28, stakeEndEpoch: 40, epochsRemaining: 12 }), pools: [pool('Anvil Seller Beta')] }));
    expect(html).toContain('Lock duration');
    expect(html).toContain('84 days');
    expect(html).toContain('starts 2026-10-22 UTC');
    expect(html).toContain('unlocks 2027-01-14 UTC');
  });

  it('labels active duration as remaining rather than restarting the lock', () => {
    mocks.epoch.mockReturnValue({ current: 27, genesis: 1775728461, epochDuration: 604800 });
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position(), pools: [] }));
    expect(html).toContain('Remaining lock');
    expect(html).toContain('up to 77 days');
    expect(html).toContain('unlocks 2026-12-31 UTC');
  });

  it('falls back to epoch numbers when date metadata is unavailable', () => {
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position(), pools: [] }));
    expect(html).toContain('Remaining lock');
    expect(html).toContain('unlocks epoch 38');
    expect(html).not.toContain('days');
  });

  it('does not show a countdown for a perpetual lock', () => {
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position({ maxLocked: true, maxLockedNext: true }), pools: [] }));
    expect(html).toContain('>Max lock</span>');
    expect(html).not.toContain('No scheduled unlock');
    expect(html).not.toContain('Remaining lock');
    expect(html).not.toContain('unlocks epoch');
  });

  it('identifies expired locks rather than showing a remaining duration', () => {
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position({ state: 'matured', epochsRemaining: 0 }), pools: [] }));
    expect(html).toContain('Lock expired');
    expect(html).not.toContain('Remaining lock');
  });

  it('identifies the source seller and amount instead of a position ID', () => {
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position({ id: 30, amount: '200000000000000000000' }), pools: [pool('Anvil Seller Beta')] }));
    expect(html).toContain('Anvil Seller Beta');
    expect(html).toContain('200 ANTS');
    expect(html).not.toContain('#30');
    expect(html).not.toContain('position(s)');
  });

  it('preserves the amount when seller metadata is missing', () => {
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position(), pools: [] }));
    expect(html).toContain('Unknown seller');
    expect(html).toContain('125 ANTS');
  });
});

describe('seller directory', () => {
  it.each(['Anvil Seller Alpha', null])('shows only the seller name in its first column (%s)', name => {
    const html = renderToStaticMarkup(createElement(PoolsTable, { pools: [pool(name)], currentEpoch: 27, loading: false, onOpen: vi.fn(), onStake: vi.fn() }));
    expect(html).toContain('>Seller<');
    expect(html).toContain(name ?? 'Unnamed seller');
    expect(html).not.toContain('86939');
    expect(html).not.toContain('0x148C');
    expect(html).toContain('1 seller</span>');
  });
});

describe('positions table', () => {
  it('reports a failed position feed without promising fallback reads', () => {
    mocks.page.mockReturnValue({ data: null, loading: false, error: 'Antscan positions are unavailable', refresh: vi.fn() });
    const html = renderToStaticMarkup(createElement(PositionsCard, { pools: [] }));
    expect(html).toContain('Antscan positions are unavailable');
    expect(html).not.toContain('fallback position reads');
    expect(html).not.toContain('No open positions');
    expect(html).toContain('Positions are currently unavailable.');
  });

  it.each([true, false])('shows loading rather than an empty wallet before the first snapshot (syncing: %s)', reconciling => {
    mocks.page.mockReturnValue({ data: null, loading: !reconciling, reconciling, error: null, refresh: vi.fn() });
    const html = renderToStaticMarkup(createElement(PositionsCard, { pools: [] }));
    expect(html).toContain('Loading positions…');
    expect(html).not.toContain('No open positions');
  });

  it('keeps cached position rows visible while syncing without exposing stale actions', () => {
    mocks.page.mockReturnValue({ data: { positions: [position()] }, loading: false, reconciling: true, error: null, refresh: vi.fn() });
    const html = renderToStaticMarkup(createElement(PositionsCard, { pools: [] }));
    expect(html).toContain('Updating…');
    expect(html).toContain('#29');
    expect(html).toContain('125');
    expect(html).not.toContain('No open positions');
    expect(html).not.toContain('More actions for position');
    expect(html).toContain('aria-label="Select position 29" disabled=""');
  });

  it.each([true, false])('shows an empty wallet only after a current response (syncing: %s)', reconciling => {
    mocks.page.mockReturnValue({ data: { positions: [] }, loading: false, reconciling, error: null, refresh: vi.fn() });
    const html = renderToStaticMarkup(createElement(PositionsCard, { pools: [] }));
    expect(html.includes('No open positions')).toBe(!reconciling);
    expect(html.includes('Updating positions…')).toBe(reconciling);
  });

  it('shows estimated position APY with help and an unavailable fallback', () => {
    mocks.epoch.mockReturnValue({ current: 27, genesis: 1775728461, epochDuration: 604800 });
    const seller = { ...pool('Alpha'), weight: '125000000000000000000', yield: { epoch: 26, startsAt: 0, endsAt: 604800, reward: '0', power: '125000000000000000000', apr: 0, apy: 0, status: 'settled' as const } };
    const html = renderPosition({ power: '125000000000000000000' }, [seller]);
    expect(html).toContain('Est. APY');
    expect(html).toContain('aria-label="About position APY"');
    expect(html).toContain('>0.00%</span>');
    expect(html).toContain('pool rewards in epoch 26');
    expect(renderPosition()).toContain('title="APY unavailable for this position.">—</span>');
  });
  it('shows seller names instead of position and pool IDs', () => {
    const html = renderPosition({}, [pool('Anvil Seller Alpha')]);
    expect(html).toContain('>Seller<');
    expect(html).toContain('Anvil Seller Alpha');
    expect(html).not.toContain('>ID<');
    expect(html).not.toContain('>Pool<');
    // The position id stays as a secondary line so split/merge results can be told apart.
    expect(html).toContain('#29');
    expect(html).not.toContain('86939');
    expect(html).toContain('Select position 29');
  });

  it.each([false, true])('groups every position action in the menu when maxLocked is %s', maxLocked => {
    mocks.epoch.mockReturnValue({ current: 27, genesis: 1775728461, epochDuration: 604800 });
    const html = renderPosition({ maxLocked, maxLockedNext: maxLocked });
    expect(html).toContain('More actions for position 29');
    const props = mocks.menu.mock.calls[0]![0];
    const items = props.items as Array<{ label: string; disabled?: boolean }>;
    expect(items.map((item) => item.label)).toEqual(['Split', 'Extend lock', maxLocked ? 'Disable max lock' : 'Enable max lock', 'Move allocation', 'Withdraw']);
    // Extending a max-locked position is pointless: it already holds the maximum lock.
    expect(items.find((item) => item.label === 'Extend lock')?.disabled ?? false).toBe(maxLocked);
    // The menu renders closed, so no action label leaks into the row itself.
    for (const label of ['Split', 'Merge', 'Extend lock', 'Move allocation', 'Withdraw']) expect(html).not.toContain(`>${label}<`);
  });

  it('allows split while activation is pending and labels the activation epoch', () => {
    mocks.epoch.mockReturnValue({ current: 27, genesis: 1775728461, epochDuration: 604800 });
    const html = renderPosition({ state: 'pending', stakeStartEpoch: 28, changePending: true });
    const items = mocks.menu.mock.calls[0]![0].items as Array<{ label: string; disabled?: boolean }>;
    expect(items.find((item) => item.label === 'Split')?.disabled).toBe(false);
    expect(html).toContain('Activates epoch 28');
    expect(html).not.toContain('change pending');
  });

  it.each([null, '   '])('falls back to the seller address when its name is %s', name => {
    const html = renderPosition({}, [pool(name)]);
    expect(html).toContain('0x148C…6ad6');
    expect(html).not.toContain('Unknown seller');
  });

  it('handles unavailable seller metadata', () => {
    expect(renderPosition()).toContain('Unknown seller');
  });

  it('does not expand row details and retains explicit position actions', () => {
    const html = renderPosition();
    const props = mocks.table.mock.calls[0]![0];
    expect(props.onRowClick).toBeUndefined();
    expect(props.renderDetail).toBeUndefined();
    expect(html).not.toContain('Early-exit slash');
    expect(html).not.toContain('Epochs left');
    expect(html).not.toContain('Change pending');
    expect(html).toContain('More actions for position 29');
  });

  it('offers selection checkboxes for open positions and keeps the bulk bar hidden until something is selected', () => {
    const html = renderPosition();
    const props = mocks.table.mock.calls[0]![0];
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('Select all open positions');
    expect(html).toContain('Select position 29');
    expect(html).not.toContain('bulk-bar');
    expect(html).not.toContain('>clear<');
    expect(props.columns.map((column: { key: string }) => column.key)).toEqual(['select', 'seller', 'amount', 'apy', 'unlocks', 'state', 'reward', 'actions']);
  });

  it('does not offer selection on closed positions', () => {
    const html = renderPosition({ state: 'withdrawn', withdrawn: true });
    expect(html).not.toContain('Select position 29');
    expect(html).not.toContain('More actions for position 29');
  });

  it('explains status and lock expiry without implying automatic withdrawal', () => {
    const html = renderPosition({ state: 'matured' });
    expect(html).toContain('>Status<');
    expect(html).toContain('The lock has expired.');
    expect(html).toContain('Funds are not withdrawn automatically.');
  });

  it('does not imply an automatic unlock date for an existing perpetual lock', () => {
    const html = renderPosition({ maxLocked: true, maxLockedNext: true });
    expect(html).toContain('>Max lock</span>');
    expect(html).not.toContain('No scheduled unlock');
    expect(html).toContain('Disable max lock to start the countdown');
    expect(html).toContain('max lock</span>');
  });

  it('labels max-lock changes that take effect next epoch and offers the reversing action', () => {
    mocks.epoch.mockReturnValue({ current: 27, genesis: 1775728461, epochDuration: 604800 });
    const enabling = renderPosition({ maxLocked: false, maxLockedNext: true });
    expect(enabling).toContain('max lock from next epoch');
    expect(enabling).toContain('Max lock starts epoch 28');
    expect(enabling).toContain('>Max lock</span>');
    expect(enabling).not.toContain('2026-12-31');
    expect(mocks.menu.mock.calls[0]![0].items.map((item: { label: string }) => item.label)).toContain('Disable max lock');
    vi.clearAllMocks(); mocks.epoch.mockReturnValue(null);
    const disabling = renderPosition({ maxLocked: true, maxLockedNext: false });
    expect(disabling).toContain('max lock ends next epoch');
    expect(disabling).toContain('Countdown starts next epoch');
    expect(disabling).not.toContain('>Max lock</span>');
    expect(mocks.menu.mock.calls[0]![0].items.map((item: { label: string }) => item.label)).toContain('Enable max lock');
  });

  it.each([
    ['pending', 'The transaction is confirmed.'],
    ['active', 'The staking position is active and its lock has not expired.'],
  ] as const)('explains %s status', (state, description) => {
    expect(renderPosition({ state })).toContain(description);
  });
});
