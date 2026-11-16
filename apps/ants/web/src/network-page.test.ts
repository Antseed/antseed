import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetworkSnapshot } from '../../src/api-types';
import { NetworkPage } from './pages/Network';
import { Details } from './components/Details';
import { EmissionsSection } from './components/EmissionsSection';
import { emissionPercent } from './network-display';

const state = vi.hoisted(() => ({ data: null as NetworkSnapshot | null, keys: [] as string[], error: null as string | null }));
vi.mock('./data', () => ({ usePageData: (key: string) => { state.keys.push(key); return { data: state.data, error: state.error, loading: false, refresh: () => {} }; } }));
vi.mock('./components/AddressLink', () => ({ AddressLink: ({ value }: { value: string }) => createElement('span', null, value) }));
vi.mock('./hooks', () => ({ useNow: () => Date.now() }));

function fixture(): NetworkSnapshot {
  return {
    chainId: 'base-local', evmChainId: 31337, blockNumber: 123, blockTimestamp: 1000, fetchedAt: Date.now(), activation: 'active',
    epoch: { current: 25, effective: 22, genesis: 0, epochDuration: 100, nextBoundaryAt: 2600, secondsToBoundary: 50 },
    shareDenominator: 100000, initialEmission: '5000000000000000000000000', halvingInterval: 104,
    emission: '5000000000000000000000000', nextEmission: '5000000000000000000000000', cumulativeScheduled: '130000000000000000000000000',
    totalSupply: '1000000000000000000000000', maxSupply: '52000000000000000000000000', totalActiveStake: '1000000000000000000000', totalPowerWeight: '2000000000000000000000', usageVolume: '1000000',
    buckets: [{ name: 'seller-pools', id: 'pools', controller: null, budget: '2000000000000000000000000', nextBudget: '2000000000000000000000000' }],
    budgets: { staker: '100000000000000000000000', buyer: '0', seller: '0' },
    stakerConfig: { minShareBps: 2000, maxShareBps: 40000, stakeShareTarget: '400000000000000000000000000' }, nextStakerConfig: null, scaledStakeTarget: '400000000000000000000000000',
    usageConfig: null, nextUsageConfig: null, contracts: {}, errors: [],
  };
}

beforeEach(() => { state.data = fixture(); state.keys = []; state.error = null; });

describe('network facts', () => {
  it('leads with current reward budgets, separates bucket allowances, and labels the Anvil snapshot', () => {
    const html = renderToStaticMarkup(createElement(NetworkPage));
    expect(html).toContain('Local Anvil');
    expect(html).toContain('block 123');
    expect(html).toContain('Current epoch reward budgets · epoch 25');
    expect(html).toContain('Buyer usage rewards');
    expect(html).toContain('Seller usage rewards');
    expect(html).toContain('Live network-wide budgets—not your wallet rewards or amounts already paid.');
    expect(html).toContain('Calculated epoch budget');
    expect(html).toContain('Emission bucket allowances · epoch 25');
    expect(html).toContain('Share of scheduled emission');
    expect(html).toContain('Bucket allowance');
    expect(html.indexOf('Current epoch reward budgets')).toBeLessThan(html.indexOf('Emission bucket allowances'));
    expect(html).toContain('Bucket limits, not payouts.');
    expect(html).not.toContain('Epoch allocation limit');
    expect(html).not.toContain('Maximum epoch budget');
    expect(html).toContain('40.00%');
    expect(html).toContain('2.00%');
    expect(html).toContain('not your wallet rewards');
    expect(html).not.toContain('Editable');
    expect(html).not.toContain('>yes<');
    expect(html).not.toContain('>fixed<');
    expect(html.match(/<th\b/g)).toHaveLength(6);
  });

  it('distinguishes the reserve base allowance from additional settled remainders', () => {
    state.data!.buckets.push({ name: 'reserve', id: 'reserve', controller: null, budget: '750000000000000000000000', nextBudget: '750000000000000000000000' });
    const html = renderToStaticMarkup(createElement(EmissionsSection, { data: state.data! }));
    expect(html).toContain('Reserve — base allowance');
    expect(html).toContain('750,000 ANTS');
    expect(html).toContain('15.00%');
    expect(html).toContain('Unallocated seller-pool and usage allowances go to the burn destination (combined cap: 30% of scheduled emission)');
    expect(html).toContain('then Reserve on top of its base allowance.');
    expect(html).toContain('Requires an on-chain settlement.');
  });

  it('places an accessible budget-finality info button next to the heading', () => {
    const html = renderToStaticMarkup(createElement(EmissionsSection, { data: state.data! }));
    expect(html).not.toContain('Capped by the allowances below. Shares need not total 100%.');
    expect(html).toMatch(/<h3>Current epoch reward budgets · epoch 25 <span[^>]*><button[^>]*type="button"[^>]*aria-label="When reward budgets become final"[^>]*>i<\/button><\/span><\/h3>/);
  });

  it('loads only the shared snapshot until secondary sections are expanded', () => {
    renderToStaticMarkup(createElement(NetworkPage));
    expect(state.keys).toEqual(['network']);
  });

  it('mounts lazy details only when open', () => {
    const child = vi.fn(() => createElement('p', null, 'Loaded'));
    renderToStaticMarkup(createElement(Details, { summary: 'Details', lazy: true, children: createElement(child) }));
    expect(child).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(createElement(Details, { summary: 'Details', lazy: true, open: true, children: createElement(child) }))).toContain('Loaded');
    expect(child).toHaveBeenCalledOnce();
  });

  it('keeps stale data visible with an explicit warning', () => {
    state.error = 'RPC timeout';
    const html = renderToStaticMarkup(createElement(NetworkPage));
    expect(html).toContain('Stale network snapshot');
    expect(html).toContain('RPC timeout');
    expect(html).toContain('40.00%');
  });

  it('shows unavailable budgets rather than zero', () => {
    state.data!.budgets.staker = null;
    state.data!.errors = ['Staker budget unavailable.'];
    const html = renderToStaticMarkup(createElement(NetworkPage));
    expect(html).toContain('Unavailable');
    expect(html).toContain('Staker budget unavailable.');
  });

  it('separates changed next-epoch allowances from current limits', () => {
    state.data!.buckets[0]!.nextBudget = '1000000000000000000000000';
    const html = renderToStaticMarkup(createElement(EmissionsSection, { data: state.data! }));
    expect(html).toContain('Next epoch · 26');
    expect(html).toContain('40.00%');
    expect(html).toContain('20.00%');
  });

  it('does not mark a budget finalized merely because the local countdown ended', () => {
    state.data!.epoch.secondsToBoundary = 0;
    expect(renderToStaticMarkup(createElement(NetworkPage))).toContain('Awaiting chain update');
  });

  it.each([
    ['0', '100', '0.00%'], ['1', '3', '33.33%'], ['10', '0', '—'], [null, '100', '—'], ['1', null, '—'],
  ])('formats budget %s of emission %s without unsafe ratios', (budget, emission, expected) => {
    expect(emissionPercent(budget, emission)).toBe(expected);
  });
});
