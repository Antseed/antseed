import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedInviteView, InviteAllowanceView, ReferralView } from '../../src/api-types';
import { AppContext, type AppValue } from './app-context';
import { InviteRow } from './pages/Rewards';

const state = vi.hoisted(() => ({
  // useState slots by call order, kept across renders so each render continues the last one's state.
  slots: [] as unknown[],
  cursor: 0,
  buttons: [] as Array<{ children: ReactNode; disabled?: boolean; onClick?: () => void }>,
  createInvite: null as (() => Promise<CreatedInviteView>) | null,
}));
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    const set = (next: unknown) => { state.slots[index] = typeof next === 'function' ? (next as (previous: unknown) => unknown)(state.slots[index]) : next; };
    return [state.slots[index], set];
  } };
});
vi.mock('./api', async original => {
  const actual = await original<typeof import('./api')>();
  return { ...actual, api: { ...actual.api, createInvite: () => state.createInvite!() } };
});
vi.mock('./wallet', () => ({ BuyerWalletAction: () => null }));
vi.mock('./components/ui', async original => ({
  ...await original<typeof import('./components/ui')>(),
  Button: (props: { children: ReactNode; disabled?: boolean; onClick?: () => void }) => {
    state.buttons.push(props);
    return createElement('button', { disabled: props.disabled }, props.children);
  },
}));

const context = { config: { address: '0x0000000000000000000000000000000000000001', chainId: 'base-mainnet', evmChainId: 8453, readOnly: false } } as AppValue;
const viewIn = (invites: InviteAllowanceView | null): ReferralView => ({ available: true, indexed: true, payable: '0', claimableEpochs: [], referredCount: 0, invites });

function render(view: ReferralView) {
  state.cursor = 0;
  state.buttons = [];
  return renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, createElement(InviteRow, { view })));
}

function button(label: string) {
  const found = state.buttons.find(entry => entry.children === label);
  expect(found).toBeDefined();
  return found!;
}

async function click(label: string) {
  button(label).onClick!();
  await new Promise(resolve => setTimeout(resolve, 0));
}

const left = (count: number, quota: number) => `<span>${count}</span><span class="bucket-amount-detail">of ${quota} left this week</span>`;

beforeEach(() => {
  state.slots = [];
  state.createInvite = null;
});

describe('invite row allowance', () => {
  it('offers invites again when the view refreshes into a new week after the last one was created', async () => {
    const link = 'https://antseed.com/invite/AbCdEfGhIjKlMnOp';
    state.createInvite = async () => ({ invite: 'AbCdEfGhIjKlMnOp', link, epoch: 23, index: 4, quota: 5, left: 0, expiresEpoch: 27 });
    expect(render(viewIn({ epoch: 23, quota: 5, used: 4, left: 1 }))).toContain(left(1, 5));

    await click('Create invite');
    let html = render(viewIn({ epoch: 23, quota: 5, used: 4, left: 1 }));
    expect(html).toContain(left(0, 5));
    expect(html).toContain('antseed.com/invite/AbCdEf…MnOp');
    expect(button('Create invite').disabled).toBe(true);

    // A refresh read before the invite was created doesn't bring the used invite back.
    html = render(viewIn({ epoch: 23, quota: 5, used: 4, left: 1 }));
    expect(html).toContain(left(0, 5));
    expect(button('Create invite').disabled).toBe(true);

    // The refreshed view reports the next week: its invites win, and the last link stays copyable.
    html = render(viewIn({ epoch: 24, quota: 3, used: 0, left: 3 }));
    expect(html).toContain(left(3, 3));
    expect(button('Create invite').disabled).toBe(false);
    expect(button('Copy')).toBeDefined();
  });

  it('follows invites another client issued in the same week', async () => {
    state.createInvite = async () => ({ invite: 'a', link: 'https://antseed.com/invite/a', epoch: 23, index: 0, quota: 5, left: 3, expiresEpoch: 27 });
    render(viewIn({ epoch: 23, quota: 5, used: 1, left: 4 }));
    await click('Create invite');
    expect(render(viewIn({ epoch: 23, quota: 5, used: 2, left: 3 }))).toContain(left(3, 5));

    // The CLI issued the rest of the week's invites.
    expect(render(viewIn({ epoch: 23, quota: 5, used: 5, left: 0 }))).toContain(left(0, 5));
    expect(button('Create invite').disabled).toBe(true);
  });

  it('keeps a failed creation to the week it happened in', async () => {
    state.createInvite = async () => { throw new Error('All 5 invites for this week are taken. More unlock next week.'); };
    render(viewIn({ epoch: 23, quota: 5, used: 4, left: 1 }));
    await click('Create invite');
    expect(render(viewIn({ epoch: 23, quota: 5, used: 4, left: 1 }))).toContain('role="alert">All 5 invites for this week are taken.');

    const html = render(viewIn({ epoch: 24, quota: 5, used: 0, left: 5 }));
    expect(html).not.toContain('role="alert"');
    expect(html).toContain(left(5, 5));
    expect(button('Create invite').disabled).toBe(false);
  });

  it('creates invites from the on-chain allowance when no explorer indexes referrals', async () => {
    const unindexed: ReferralView = { ...viewIn({ epoch: 40, quota: 4, used: 1, left: 3 }), indexed: false };
    const link = 'https://antseed.com/invite/OnChainInvite123';
    state.createInvite = async () => ({ invite: 'OnChainInvite123', link, epoch: 40, index: 2, quota: 4, left: 2, expiresEpoch: 44 });
    expect(render(unindexed)).toContain(left(3, 4));
    expect(button('Create invite').disabled).toBe(false);

    await click('Create invite');
    const html = render(unindexed);
    expect(html).toContain(left(2, 4));
    expect(html).toContain('antseed.com/invite/OnChai…e123');
  });
});
