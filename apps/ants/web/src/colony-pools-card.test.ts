import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColonyPoolsView } from '../../src/api-types';
import { AppContext, type AppValue } from './app-context';
import type { ActionButtonProps } from './components/Confirm';
import { ColonyPoolsCard } from './components/ColonyPools';

const state = vi.hoisted(() => ({ data: null as ColonyPoolsView | null, error: null as string | null, actions: [] as ActionButtonProps[] }));
vi.mock('./data', () => ({ usePageData: () => ({ data: state.data, error: state.error, loading: false, reconciling: false, refresh: () => {} }) }));
vi.mock('./components/Confirm', () => ({ ActionButton: (props: ActionButtonProps) => {
  state.actions.push(props);
  return createElement('button', { disabled: props.disabled }, props.label);
} }));

const wallet = '0x0000000000000000000000000000000000000001';
const pool = '0x00000000000000000000000000000000000000aa';
const context = { config: { address: wallet, chainId: 'base-mainnet', evmChainId: 8453, readOnly: false } } as AppValue;
const render = () => renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, createElement(ColonyPoolsCard)));
const claim = () => state.actions.find((action) => action.title === 'Claim Mac earnings');

beforeEach(() => {
  state.data = null;
  state.error = null;
  state.actions = [];
});

describe('Mac earnings card', () => {
  it('says the earnings could not be loaded instead of treating the wallet as having no Macs', () => {
    state.error = 'Colony pool 0xaa: epochWeight unavailable.';
    const html = render();
    expect(html).toContain('Mac earnings could not be loaded');
    expect(html).toContain('Retry');
    expect(html).not.toContain('Link a Mac');
  });

  it('shows nothing until the first read answers', () => {
    expect(render()).toBe('');
  });

  it('offers to link a Mac when the wallet has none', () => {
    state.data = { pools: [] };
    expect(render()).toContain('Link a Mac');
  });

  it('shows an unreadable pool with Retry and, for a linked one, Forget, without hiding readable pools', () => {
    const broken = '0x00000000000000000000000000000000000000cc';
    state.data = { pools: [
      { address: pool, usdcOwed: '2500000', antsOwed: '0', antsEpochs: [], unfundedEpochs: [], forgettable: false },
      { address: broken, usdcOwed: '0', antsOwed: '0', antsEpochs: [], unfundedEpochs: [], error: 'missing revert data', forgettable: true },
    ] };
    const html = render();
    expect(html).toContain('This pool could not be read');
    expect(html).toContain('Forget it');
    expect(html).toContain('2.5');
    // One claim button, for the readable pool only.
    expect(state.actions.filter((action) => action.title === 'Claim Mac earnings')).toHaveLength(1);
    expect(claim()?.body).toEqual({ pool, usdc: true, ants: true });
  });

  it('offers no Forget for a configured pool that cannot be read', () => {
    state.data = { pools: [{ address: pool, usdcOwed: '0', antsOwed: '0', antsEpochs: [], unfundedEpochs: [], error: 'RPC unavailable', forgettable: false }] };
    const html = render();
    expect(html).toContain('This pool could not be read');
    expect(html).not.toContain('Forget it');
  });

  it('keeps showing earlier amounts after a failed refresh, marked out of date, with claims off', () => {
    state.data = { pools: [{ address: pool, usdcOwed: '2500000', antsOwed: '0', antsEpochs: [], unfundedEpochs: [], forgettable: false }] };
    expect(render()).not.toContain('out of date');
    expect(claim()?.disabled).toBe(false);
    state.actions = [];
    state.error = 'RPC unavailable';
    const html = render();
    expect(html).toContain('may be out of date');
    expect(claim()?.disabled).toBe(true);
    expect(claim()?.disabledReason).toMatch(/could not be refreshed/);
  });
});
