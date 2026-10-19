import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildersView, JobView } from '../../src/api-types';
import { AppContext, type AppValue } from './app-context';
import { BuildersCard } from './pages/Rewards';

const state = vi.hoisted(() => ({
  jobs: [] as JobView[],
  buttons: [] as Array<{ children: ReactNode; onClick?: () => void }>,
  view: null as BuildersView | null,
  load: null as (() => Promise<BuildersView>) | null,
  requests: [] as number[][],
}));
// Effects run during the server render, so each render is a mount that processes the job list.
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: () => void) => { effect(); },
}));
vi.mock('./jobs', () => ({ useJobList: () => state.jobs }));
const unowned = (agentId: number) => ({ agentId, owner: null, owned: false, firstParty: null, payable: '0', claimableEpochs: [] });
// The builders read echoes back the tracked ids in its key (or shows a loaded view), so tracked agents show a Remove button.
vi.mock('./data', () => ({ usePageData: (key: string | null, load: () => Promise<BuildersView>) => {
  state.load = load;
  const ids = (key ?? '').split(':')[2]?.split(',').filter(Boolean).map(Number) ?? [];
  const data: BuildersView = state.view ?? { available: true, agents: ids.map(unowned) };
  return { data, error: null, loading: false, reconciling: false, refresh: () => {} };
} }));
// The server reads at most 20 requested ids per request and adds the owned first-party CLI agent.
vi.mock('./api', async original => {
  const actual = await original<typeof import('./api')>();
  return { ...actual, api: { ...actual.api, builders: async (ids: number[]): Promise<BuildersView> => {
    state.requests.push(ids);
    if (ids.length > 20) throw new Error('Request at most 20 client agent ids at a time.');
    const cli = { ...unowned(5), owner: '0x0000000000000000000000000000000000000001', owned: true, firstParty: 'cli' as const };
    return { available: true, agents: [cli, ...ids.map(unowned)] };
  } } };
});
vi.mock('./wallet', () => ({ BuyerWalletAction: () => null }));
vi.mock('./components/Confirm', () => ({ ActionButton: () => null }));
vi.mock('./components/ui', async original => ({
  ...await original<typeof import('./components/ui')>(),
  Button: (props: { children: ReactNode; onClick?: () => void }) => {
    state.buttons.push(props);
    return createElement('button', null, props.children);
  },
}));

const chainId = 'base-mainnet';
const context = { config: { address: '0x0000000000000000000000000000000000000001', chainId, evmChainId: 8453, readOnly: false } } as AppValue;
const storage = new Map<string, string>();
const tracked = () => JSON.parse(storage.get(`antseed.ants.builderAgentIds:${chainId}`) ?? '[]') as number[];
const registration: JobView = { id: 'register-1', kind: 'builder-register', status: 'done', steps: [], startedAt: 1, result: { agentId: 77 } };

function mount() {
  state.buttons = [];
  return renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, createElement(BuildersCard)));
}

beforeEach(() => {
  storage.clear();
  state.jobs = [];
  state.view = null;
  state.load = null;
  state.requests = [];
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe('builders card tracked agents', () => {
  it('tracks a newly registered agent once, so a removed agent stays removed after a remount', () => {
    mount();
    expect(tracked()).toEqual([]);

    state.jobs = [registration];
    expect(mount()).toContain('Agent #77');
    expect(tracked()).toEqual([77]);

    state.buttons.find((button) => button.children === 'Remove')!.onClick!();
    expect(tracked()).toEqual([]);

    // Navigate away and back: the jobs provider still holds the completed registration.
    expect(mount()).not.toContain('Agent #77');
    expect(tracked()).toEqual([]);
  });

  it('still tracks a later registration after an earlier one was removed', () => {
    state.jobs = [registration];
    mount();
    state.buttons.find((button) => button.children === 'Remove')!.onClick!();

    state.jobs = [{ ...registration, id: 'register-2', result: { agentId: 78 } }, registration];
    expect(mount()).toContain('Agent #78');
    expect(tracked()).toEqual([78]);
  });

  it('lists and can remove agents beyond one request: a 21st added id and a newly registered one', async () => {
    const added = Array.from({ length: 21 }, (_, i) => 101 + i); // what Add persisted
    storage.set(`antseed.ants.builderAgentIds:${chainId}`, JSON.stringify(added));
    state.jobs = [registration];
    mount();
    expect(tracked()).toEqual([...added, 77]);

    mount();
    state.view = await state.load!();
    expect(state.requests.map((batch) => batch.length)).toEqual([20, 2]);
    expect(state.view.agents.map((agent) => agent.agentId)).toEqual([5, ...added, 77]);

    const markup = mount();
    expect(markup).toContain('Agent #121');
    expect(markup).toContain('Agent #77');
    // Every tracked id has a Remove control; the owned first-party agent leads without one.
    const removes = state.buttons.filter((button) => button.children === 'Remove');
    expect(removes).toHaveLength(22);
    removes[21]!.onClick!();
    expect(tracked()).toEqual(added);
  });
});
