import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type AppValue } from './app-context';
import { LockSlider } from './components/LockSlider';
import { RewardsPage } from './pages/Rewards';
import { SellerPage } from './pages/Seller';
import { StakePage } from './pages/Stake';
import { PositionsPage } from './pages/Positions';
import { AddressesPage } from './pages/Addresses';
import { Layout } from './components/Layout';
import { nearestIndex, slotIndex } from './components/chart-hover';
import { parseRoute } from './router';
import { StakeForm } from './components/StakeForm';
import { poolName, poolLabel, PoolsTable, PoolDrawer, sortPoolsByMetric } from './components/Pools';
import { formatYieldPercent, poolApyRange, poolApyEstimates } from './pool-yield';
import type { PoolView, PoolsView, RewardsView, SellerView } from '../../src/api-types';

const state = vi.hoisted(() => ({ data: { 'positions:current': { config: { minStakeEpochs: 1, maxStakeEpochs: 104, stakeActivationDelay: 1 } } } as Record<string, unknown>, keys: [] as Array<string | null>, loadingPools: false, partialPools: false, reconcilingPools: false, poolsError: null as string | null }));
vi.mock('@antseed/ui', async original => ({
  ...await original<typeof import('@antseed/ui')>(),
  Modal: ({ children, title, subtitle, isOpen }: { children: ReactNode; title: ReactNode; subtitle?: ReactNode; isOpen: boolean }) => isOpen ? createElement('section', { role: 'dialog' }, createElement('h2', null, title), subtitle, children) : null,
}));
vi.mock('./data', () => ({ usePageData: (key: string | null) => { state.keys.push(key); return { data: key ? state.data[key] ?? null : null, error: key === 'pools' ? state.poolsError : null, loading: key === 'pools' && state.loadingPools, partial: key === 'pools' && state.partialPools, reconciling: key === 'pools' && state.reconcilingPools, refresh: () => {} }; } }));
vi.mock('./jobs', () => ({ useJobs: () => ({ running: false, start: () => {}, toasts: [], dismissToast: () => {}, drawerOpen: false, setDrawerOpen: () => {} }) }));
vi.mock('./wallet', () => ({ BuyerWalletAction: () => createElement('button', null, 'Connect wallet'), WalletControls: () => createElement('button', null, 'Wallet') }));

const context = {
  config: { address: '0x0000000000000000000000000000000000000001', buyerAddress: '0x0000000000000000000000000000000000000002', chainId: 'base-mainnet', evmChainId: 8453, readOnly: true },
  overview: { epoch: { current: 22, genesis: 1775728461, epochDuration: 604800 } },
  theme: 'light', toggleTheme: () => {},
} as AppValue;

function render(child: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, child));
}

describe('staking dashboard displays', () => {
  it('keeps partial-result warnings hidden during recovery and shows retry only once loading finishes', () => {
    const previousPools = state.data.pools;
    state.data.pools = { source: 'chain', sourceError: 'Explorer timeout', pools: [], networkVolumes: [], currentEpoch: 22 };
    state.partialPools = true;
    state.loadingPools = true;
    try {
      const loading = render(createElement(StakePage));
      expect(loading).toContain('Updating sellers…');
      expect(loading).not.toContain('Could not load');
      expect(loading).not.toContain('Try again');
      state.loadingPools = false;
      const exhausted = render(createElement(StakePage));
      expect(exhausted).toContain('Could not load the full seller list');
      expect(exhausted).toContain('Only pools you stake in are shown');
      expect(exhausted).toContain('Try again');
      expect(exhausted).toContain('You have no staked pools to show');
      expect(exhausted).not.toContain('No sellers are ready');
      state.data.pools = { ...state.data.pools as object, source: 'indexer', sourceError: null };
      const retained = render(createElement(StakePage));
      expect(retained).toContain('statistics may be out of date');
      state.partialPools = false;
      const recovered = render(createElement(StakePage));
      expect(recovered).not.toContain('Could not load');
      expect(recovered).not.toContain('Try again');
    } finally { state.data.pools = previousPools; state.partialPools = false; state.loadingPools = false; }
  });

  it('does not report no staked pools in chain-only mode while your stake syncs', () => {
    const previousPools = state.data.pools;
    state.data.pools = { source: 'chain', sourceError: null, walletSyncing: true, pools: [], networkVolumes: [], currentEpoch: 22 };
    state.reconcilingPools = true;
    try {
      const html = render(createElement(StakePage));
      expect(html).toContain('Updating your stake…');
      expect(html).not.toContain('You have no staked pools');
    } finally { state.data.pools = previousPools; state.reconcilingPools = false; }
  });

  it('does not suggest retry for intentionally unconfigured explorers', () => {
    const previousPools = state.data.pools;
    state.data.pools = { source: 'chain', sourceError: null, pools: [], networkVolumes: [], currentEpoch: 22 };
    try {
      const html = render(createElement(StakePage));
      expect(html).toContain('No explorer configured');
      expect(html).not.toContain('Try again');
      expect(html).not.toContain('Could not load');
    } finally { state.data.pools = previousPools; }
  });

  it('does not present a failed read as an empty seller network', () => {
    const previousPools = state.data.pools;
    state.data.pools = null;
    state.poolsError = 'RPC unavailable';
    try {
      const html = render(createElement(StakePage));
      expect(html).toContain('RPC unavailable');
      expect(html).not.toContain('No sellers are ready');
    } finally { state.data.pools = previousPools; state.poolsError = null; }
  });
  it('shows protocol addresses without the environment section', () => {
    const previousOverview = state.data.overview;
    const contractAddress = '0x0000000000000000000000000000000000000042';
    state.data.overview = { addresses: { ANTSToken: contractAddress }, rpcUrl: 'http://127.0.0.1:54304' };
    try {
      const html = render(createElement(AddressesPage));
      expect(html).toContain('Protocol contracts');
      expect(html).toContain('ANTSToken');
      expect(html).toContain(contractAddress);
      for (const label of ['Environment', 'EVM chain id', 'RPC URL', 'Wallet', 'Data dir', 'Mode']) expect(html).not.toContain(label);
      expect(html).not.toContain('http://127.0.0.1:54304');
    } finally { state.data.overview = previousOverview; }
  });
  it('omits the explorer loading message while seller statistics load', () => {
    const previousPools = state.data.pools;
    state.data.pools = null;
    state.loadingPools = true;
    try {
      const html = render(createElement(StakePage));
      expect(html).toContain('Sellers');
      expect(html).toContain('Loading sellers…');
      expect(html).not.toContain('status-line');
      expect(html).not.toContain('0 sellers');
      expect(html).not.toContain('Loading pool statistics from the explorer');
    } finally { state.data.pools = previousPools; state.loadingPools = false; }
  });
  it('keeps the provider popup informational and reads models only for its seller', () => {
    const pool = { agentId: 42, seller: context.config.address, profile: null, stakeable: true, hasPool: true, activeStake: '0', weight: '0', powerShareBps: 0, lastEpochEmission: null, volumes: [] } as unknown as PoolView;
    const view = { currentEpoch: 23, networkVolumes: [], explorer: null } as unknown as PoolsView;
    const html = render(createElement(PoolDrawer, { pool, view, onClose: () => {} }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Models &amp; usage');
    expect(html).not.toContain('Stake into this pool');
    expect(html).not.toContain('drawer-backdrop');
    expect(state.keys).toContain(`seller-models:${context.config.address}`);
    expect((html.match(/<button[^>]*>.*?<\/button>/g) ?? []).some(button => /Stake/.test(button))).toBe(false);
  });
  it.each([
    { readOnly: false, claimable: true, total: '7000000000000000000', visible: true },
    { readOnly: true, claimable: true, total: '7000000000000000000', visible: false },
    { readOnly: false, claimable: false, total: '7000000000000000000', visible: false },
    { readOnly: false, claimable: true, total: '0', visible: false },
  ])('keeps Stake rewards visible but enables it only for eligible buyers: %j', ({ readOnly, claimable, total, visible }) => {
    const previousData = state.data.rewards;
    const previousConfig = context.config;
    const previousOverview = context.overview;
    context.config = { ...context.config, readOnly };
    context.overview = { ...context.overview, wallet: { eth: '1000000000000000' } } as AppValue['overview'];
    state.data.rewards = {
      scope: 'buyer',
      buyerUsage: { total, operator: context.config.address, claimable },
      sellerUsage: { agentId: 0 },
      legacy: { buyer: '5000000000000000000' },
    };
    try {
      const html = render(createElement(RewardsPage));
      expect(html).toContain('Current buyer rewards');
      expect(html).toContain('Legacy buyer rewards');
      const button = (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).find(button => button.includes('>Stake rewards</span>'));
      expect(button).toBeDefined();
      expect(button!.includes('disabled=""')).toBe(!visible);
      expect(html).not.toContain('>Restake</span>');
    } finally { state.data.rewards = previousData; context.config = previousConfig; context.overview = previousOverview; }
  });

  it.each([
    { canTransfer: false, wrongWallet: false, failedRead: false, walletRoute: false },
    { canTransfer: true, wrongWallet: false, failedRead: false, walletRoute: true },
    { canTransfer: true, wrongWallet: true, failedRead: false, walletRoute: false },
    { canTransfer: true, wrongWallet: false, failedRead: true, walletRoute: false },
  ])('keeps legacy buyer descriptions independent of wallet eligibility: %j', ({ canTransfer, wrongWallet, failedRead }) => {
    const previousData = state.data.rewards;
    const previousConfig = context.config;
    const previousOverview = context.overview;
    const previousError = context.overviewError;
    context.config = { ...context.config, readOnly: false };
    context.overview = { ...context.overview, wallet: { eth: '1000000000000000', canTransfer } } as AppValue['overview'];
    context.overviewError = failedRead ? 'RPC unavailable' : null;
    state.data.rewards = {
      scope: 'buyer',
      buyerUsage: { total: '0', operator: wrongWallet ? context.config.buyerAddress : context.config.address, claimable: true },
      legacy: { buyer: '1991554800000000000000' },
    };
    try {
      const html = render(createElement(RewardsPage));
      const stake = (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).find(button => button.includes('>Stake rewards</span>'));
      expect(stake).toContain('disabled=""');
      expect(html).toContain('Earned from using AI services under the previous rewards system.');
      expect(html).toContain('1,991.5548');
      expect(html).not.toContain('Legacy rewards have no direct staking function.');
      expect(html).not.toContain('Claiming and staking are separate transactions.');
    } finally {
      state.data.rewards = previousData;
      context.config = previousConfig;
      context.overview = previousOverview;
      context.overviewError = previousError;
    }
  });

  it.each([false, true])('keeps M002 locked rewards distinct from released rewards (policy installed: %s)', (installed) => {
    const previousData = state.data.rewards;
    const previousConfig = context.config;
    const previousOverview = context.overview;
    context.config = { ...context.config, readOnly: false };
    context.overview = { ...context.overview, wallet: { eth: '1000000000000000', canTransfer: false } } as AppValue['overview'];
    state.data.rewards = {
      scope: 'all', total: installed ? '100000000000000000000' : '0',
      buyerUsage: { total: '0', operator: context.config.address, claimable: true },
      sellerUsage: { total: '0', claimable: false, agentId: 42 },
      staker: { total: '0', positions: [] },
      legacy: { buyer: '0', seller: '0', buyerClaimable: true },
      locked: { locked: '1000000000000000000000', claimable: installed ? '100000000000000000000' : '0', policy: installed ? context.config.address : null },
    };
    try {
      const html = render(createElement(RewardsPage));
      expect(html).toContain('Locked seller rewards');
      expect(html).toContain('Past seller rewards held in the locked pool.');
      expect(html).toContain('1,000 ANTS locked');
      expect(html).not.toContain('This wallet cannot transfer ANTS into staking.');
      expect(html.includes('M002 (unlock policy) is not installed.')).toBe(!installed);
      const lockedRow = html.slice(html.indexOf('>Locked seller rewards</div>'));
      const claimButton = lockedRow.match(/<button[^>]*>.*?<\/button>/)?.[0];
      expect(claimButton).toBeDefined();
      expect(claimButton!.includes('disabled=""')).toBe(!installed);
      expect(lockedRow).not.toContain('>Restake</span>');
    } finally { state.data.rewards = previousData; context.config = previousConfig; context.overview = previousOverview; }
  });

  it('keeps seller and existing-position rewards directly restakable when wallet transfers are restricted', () => {
    const previousData = state.data.rewards;
    const previousConfig = context.config;
    const previousOverview = context.overview;
    context.config = { ...context.config, readOnly: false };
    context.overview = { ...context.overview, wallet: { eth: '1000000000000000', canTransfer: false } } as AppValue['overview'];
    state.data.rewards = {
      scope: 'all', total: '3000000000000000000',
      buyerUsage: { total: '0', operator: context.config.address, claimable: true },
      sellerUsage: { total: '1000000000000000000', claimable: true, agentId: 42 },
      staker: { total: '2000000000000000000', positions: [{ id: 7, amount: '2000000000000000000', agentId: 42 }] },
      legacy: { buyer: '0', seller: '0', buyerClaimable: true },
      locked: { locked: '0', claimable: '0', policy: null },
    };
    try {
      const html = render(createElement(RewardsPage));
      expect(html).toContain('Staking rewards');
      expect(html).toContain('Current seller rewards');
      expect(html).not.toContain('>Restake</span>');
      const buttons = (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).filter(button => button.includes('>Stake rewards</span>') && !button.includes('disabled=""'));
      expect(buttons).toHaveLength(2);
      for (const button of buttons) expect(button).not.toContain('disabled=""');
    } finally { state.data.rewards = previousData; context.config = previousConfig; context.overview = previousOverview; }
  });

  it('loads originating buyer rewards without requesting wallet positions while disconnected', () => {
    const original = context.config.browserWallet;
    context.config.browserWallet = true;
    state.keys = [];
    try {
      const sellers = render(createElement(StakePage));
      expect(state.keys).toContain('pools');
      expect(state.keys).not.toContain('pool-stakers');
      expect(state.keys).not.toContain('positions:current');
      expect(state.keys).toContain('rewards');
      // The market page is sellers only; wallet tiles and positions live on their own page.
      expect(sellers).not.toContain('Buyer rewards');
      expect(sellers).not.toContain('Connect a wallet to see your positions.');
      const html = render(createElement(PositionsPage));
      expect(state.keys).not.toContain('positions:current');
      expect(html).toContain('Buyer rewards');
      expect(html).not.toContain('Connect a wallet to view rewards.');
      expect(html).toContain('Connect a wallet to see your positions.');
      expect(html).not.toContain('To stake buyer rewards, connect your authorized wallet using the wallet button above.');
    } finally { context.config.browserWallet = original; }
  });


  it('shows buyer rewards before connection and keeps claims disabled', () => {
    const original = context.config.browserWallet;
    const previous = state.data.rewards;
    context.config.browserWallet = true;
    state.data.rewards = {
      scope: 'buyer', total: '12000000000000000000',
      staker: { total: '0', positions: [] }, sellerUsage: { total: '0', claimable: false },
      buyerUsage: { total: '7000000000000000000', operator: context.config.address, claimable: false },
      legacy: { seller: '0', buyer: '5000000000000000000', buyerClaimable: false },
      locked: { locked: '0', claimable: '0', policy: null },
    } as unknown as RewardsView;
    state.keys = [];
    try {
      const stake = render(createElement(PositionsPage));
      expect(stake).toContain('Buyer rewards');
      expect(stake).toContain('View buyer rewards');
      expect(stake).toContain('12');
      const html = render(createElement(RewardsPage));
      expect(html).toContain('Buyer rewards');
      expect(html).toContain('Connect the authorized wallet');
      expect(html).toContain(context.config.buyerAddress);
      expect(html).toContain('Legacy buyer rewards');
      const claimButtons = (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).filter(button => button.includes('>Connect wallet</span>'));
      expect(claimButtons).toHaveLength(2);
      for (const button of claimButtons) expect(button).toContain('disabled=""');
      expect(state.keys).not.toContain('positions:current');
    } finally {
      context.config.browserWallet = original;
      state.data.rewards = previous;
    }
  });

  it('offers explicit authorization without enabling a claim when the buyer has no operator', () => {
    const previousData = state.data.rewards;
    const previousConfig = context.config;
    context.config = { ...context.config, browserWallet: true, canAuthorize: true };
    state.data.rewards = { scope: 'buyer', buyerUsage: { total: '1000000000000000000', operator: null }, legacy: { buyer: '0' } };
    try {
      const html = render(createElement(RewardsPage));
      expect(html).toContain('Authorize wallet ↗');
      expect(html).toContain('Authorize a wallet to claim or stake');
      const claim = html.match(/<button[^>]*>.*?Connect wallet<\/span>.*?<\/button>/)?.[0];
      expect(claim).toContain('disabled=""');
    } finally { state.data.rewards = previousData; context.config = previousConfig; }
  });

  it('keeps remembered positions viewable after disconnect without enabling signing', () => {
    const previousConfig = context.config;
    context.config = { ...context.config, browserWallet: true, readOnly: true, walletAddress: context.config.address };
    state.keys = [];
    try {
      const html = render(createElement(PositionsPage));
      expect(state.keys).toContain('positions:current');
      expect(html).not.toContain('Connect a wallet to see your positions.');
    } finally { context.config = previousConfig; }
  });

  it('uses the activation epoch for new locks and the existing end for extensions', () => {
    const props = { value: 104, max: 104, onChange: () => {} };
    expect(render(createElement(LockSlider, { ...props, startEpoch: 23 }))).toContain('2028-09-14');
    expect(render(createElement(LockSlider, { ...props, value: 1, startEpoch: 126 }))).toContain('2028-09-14');
    expect(render(createElement(LockSlider, props))).not.toContain('unlocks');
  });

  it('shows the locked balance without release-policy copy in its description', () => {
    state.data.rewards = {
      total: '0', staker: { total: '0', positions: [] }, sellerUsage: { total: '0', claimable: false },
      buyerUsage: { total: '0', claimable: false }, legacy: { seller: '0', buyer: '0', buyerClaimable: true },
      locked: { locked: '246820549600000000000000', claimable: '0', policy: null },
    } as unknown as RewardsView;
    const html = render(createElement(RewardsPage));
    expect(html).toContain('246,820.5496');
    expect(html).toContain('Locked seller rewards');
    expect(html).toContain('Past seller rewards held in the locked pool.');
  });

  it('formats legacy USDC separately from ANTS and grant counts', () => {
    state.data[`seller:${context.config.address}`] = {
      agentId: 42, identityRegistered: true, registryBound: false, eligible: true,
      legacyStake: '10000000', poolActiveStake: '1000000000000000000', minPoolStake: '1',
      legacyEligibilityEnabled: true,
      starter: { initialized: false, remaining: '78', amount: '1000000000000000000', endEpoch: 126, legacyEligible: true, expired: false, claimable: true },
    } as SellerView;
    const html = render(createElement(SellerPage));
    expect(html).toContain('10 USDC');
    expect(html).toMatch(/Grants remaining[\s\S]*?78/);
    expect(html).not.toContain('&lt;0.0001 ANTS');
  });

  it('only lists stakeable sellers and offers no toggle to reveal unready sellers', () => {
    const base = { weight: '0', activeStake: '0', powerShareBps: 0, yourPower: '0', volumes: [], lastEpochRewardPer1kPower: null, projectedRewardPer1kPower: null };
    const pools = [{ ...base, agentId: 1, stakeable: true, profile: { name: 'Ready seller' } }, { ...base, agentId: 2, stakeable: false, profile: { name: 'Unbound seller' } }] as unknown as PoolView[];
    const html = render(createElement(PoolsTable, { pools, currentEpoch: 25, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain('Ready seller');
    expect(html).not.toContain('Unbound seller');
    expect(html).toContain('1 seller</span>');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('2 sellers');
  });

  it('shows an empty staking directory when every seller is unready', () => {
    const pools = [{ agentId: 1, stakeable: false, profile: { name: 'Unbound seller' } }] as unknown as PoolView[];
    const html = render(createElement(PoolsTable, { pools, currentEpoch: 25, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain('No sellers are ready for staking yet.');
    expect(html).toContain('0 sellers</span>');
    expect(html).not.toContain('Unbound seller');
    expect(html).not.toContain('Turn off the filter');
  });


  it('sorts APY and valid last-epoch volume in both directions, with unknown values last', () => {
    const pool = (agentId: number, apy: number | null, usdc: string, volumeStatus = 'available') => ({
      agentId, yield: { epoch: 24, apy, status: apy === null ? 'unavailable' : 'settled', startsAt: 0, endsAt: 604800, reward: apy === null ? null : (BigInt(apy) * 10n ** 18n).toString(), power: '10000000000000000000000', minLockEpochs: 1, maxLockEpochs: 104 },
      volumes: [{ epoch: 24, usdc }, { epoch: 25, usdc: '999999999999999999' }], volumeStatus,
    }) as PoolView;
    const pools = [pool(1, 12, '100'), pool(2, 0, '900'), pool(3, null, '99999', 'stale')];
    const ids = (rows: PoolView[]) => rows.map(p => p.agentId);
    expect(ids(sortPoolsByMetric(pools, 'apy', 'descending', 25))).toEqual([1, 2, 3]);
    expect(ids(sortPoolsByMetric(pools, 'apy', 'ascending', 25))).toEqual([2, 1, 3]);
    expect(ids(sortPoolsByMetric(pools, 'volume', 'descending', 25))).toEqual([2, 1, 3]);
    expect(ids(sortPoolsByMetric(pools, 'volume', 'ascending', 25))).toEqual([1, 2, 3]);
    const html = render(createElement(PoolsTable, { pools: [], currentEpoch: 25, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('Sort by APY, ascending');
    expect(html).toContain('Sort by TVL, descending');
    expect(html).toContain('Total active stake in this pool (ANTS).');
    expect(html).not.toContain('APY range:');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('Estimated APY');
  });

  it('shows and sorts completed-epoch volume without yield data', () => {
    const pool = { agentId: 1, stakeable: true, profile: null, activeStake: '3000000000000000000', volumes: [{ epoch: 24, usdc: '123000000' }, { epoch: 25, usdc: '999000000' }], volumeStatus: 'available' } as PoolView;
    const other = { ...pool, agentId: 2, volumes: [{ epoch: 24, usdc: '456000000' }] };
    expect(sortPoolsByMetric([pool, other], 'volume', 'descending', 25).map(entry => entry.agentId)).toEqual([2, 1]);
    expect(sortPoolsByMetric([pool, other], 'volume', 'ascending', 25).map(entry => entry.agentId)).toEqual([1, 2]);
    const html = render(createElement(PoolsTable, { pools: [pool], currentEpoch: 25, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain('123');
    expect(html).not.toContain('999');
    expect(html).toContain('Sort by TVL, descending');
    expect(html).toContain('sparkline--empty');
  });

  it('displays a single lock-dependent range with an unsettled-reward label in the table and drawer', () => {
    const pool = { agentId: 1, stakeable: true, profile: null, activeStake: '3000000000000000000', weight: '0', powerShareBps: 0, lastEpochEmission: null, volumes: [], yield: { epoch: 24, startsAt: 0, endsAt: 604800, apr: 11, apy: 12.34, status: 'estimated', reward: '1000000000000000000', power: '10000000000000000000000', minLockEpochs: 1, maxLockEpochs: 104 } } as unknown as PoolView;
    const range = poolApyRange(pool.yield);
    const expected = `${formatYieldPercent(range.oneWeek.apy)} – ${formatYieldPercent(range.twoYears.apy)}`;
    const html = render(createElement(PoolsTable, { pools: [pool], currentEpoch: 25, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain(expected);
    expect(html).not.toContain('12.34%');
    expect(html).toContain('est.');
    expect(html).toContain('Source epoch 24');
    expect(html).toContain('1 week: 1 epoch(s), 7 days; 2 years: 104 epoch(s), 728 days');
    expect(html).toContain('compounding is not automatic');
    expect(html).not.toContain('APY range:');
    expect(html).not.toContain('APY sorting uses the 1-week rate.');
    expect(html).not.toContain('APY · 1 month');
    expect(html).not.toContain('APY · 1 year');
    const view = { currentEpoch: 25, networkVolumes: [], explorer: null } as unknown as PoolsView;
    const drawer = render(createElement(PoolDrawer, { pool, view, onClose: () => {} }));
    expect(drawer).toContain('Estimated APY by lock');
    expect(drawer).toContain('Unsupported');
    for (const period of poolApyEstimates(pool.yield)) {
      expect(drawer).toContain(`<dt>${period.label}</dt>`);
      if (period.apy !== null) expect(drawer).toContain(formatYieldPercent(period.apy));
    }
    expect(drawer).not.toContain('APY · 1 week–2 years');
  });

  it.each([100, 1000, 2000])('shows a single >10.000%% only when an APY endpoint exceeds 10,000%% (reward: %s)', (reward) => {
    const pool = { agentId: 1, stakeable: true, profile: null, activeStake: '3000000000000000000', weight: '0', powerShareBps: 0, lastEpochEmission: null, volumes: [], yield: { epoch: 24, startsAt: 0, endsAt: 604800, status: 'estimated', reward: (BigInt(reward) * 10n ** 18n).toString(), power: '10000000000000000000000', minLockEpochs: 1, maxLockEpochs: 104 } } as unknown as PoolView;
    const range = poolApyRange(pool.yield);
    const hidden = reward !== 100;
    if (hidden) expect(range.twoYears.apy).toBeGreaterThan(10000);
    else {
      expect(range.oneWeek.apy).toBeGreaterThan(10);
      expect(range.twoYears.apy).toBeLessThan(10000);
    }
    if (reward === 1000) expect(range.oneWeek.apy).toBeLessThan(10000);
    if (reward === 2000) expect(range.oneWeek.apy).toBeGreaterThan(10000);
    const expected = hidden ? '&gt;10.000%' : `${formatYieldPercent(range.oneWeek.apy)} – ${formatYieldPercent(range.twoYears.apy)}`;
    const table = render(createElement(PoolsTable, { pools: [pool], currentEpoch: 25, loading: false, onOpen: () => {}, onStake: () => {} }));
    const drawer = render(createElement(PoolDrawer, { pool, view: { currentEpoch: 25, networkVolumes: [], explorer: null } as unknown as PoolsView, onClose: () => {} }));
    expect(table).toContain(hidden ? `>${expected}</span>` : `>${expected}`);
    expect(table.includes('APY is shown as &gt;10.000% when either end of the range exceeds 10,000%.')).toBe(hidden);
    expect(table).not.toContain('N/A');
    expect(drawer).not.toContain('N/A');
    const estimates = [...drawer.matchAll(/<dt>([^<]*)<\/dt><dd>(.*?)<\/dd>/g)];
    for (const period of poolApyEstimates(pool.yield)) {
      const row = estimates.find(match => match[1] === period.label);
      expect(row?.[2]).toContain(period.status === 'unsupported' ? 'Unsupported' : formatYieldPercent(period.apy).replace('>', '&gt;'));
    }
  });

  it.each(['available', 'stale', 'unavailable'] as const)('preserves seller history as pool details load (history: %s)', (status) => {
    const previous = state.data['pool:47214'];
    delete state.data['pool:47214'];
    const pool = {
      agentId: 47214, stakeable: true, hasPool: true, profile: null, activeStake: '1000000000000000000',
      weight: '103000000000000000000', powerShareBps: 384, lastEpochEmission: '155714266005655605361',
      volumeStatus: 'available', volumes: [
        { epoch: 23, usdc: '21419582' }, { epoch: 22, usdc: '4262829' },
        { epoch: 21, usdc: '21427226' }, { epoch: 19, usdc: '0' }, { epoch: 15, usdc: '670601' },
      ],
    } as PoolView;
    const view = { currentEpoch: 23, networkVolumes: [{ epoch: 22, usdc: '7751200000' }], explorer: null } as PoolsView;
    const drawer = () => render(createElement(PoolDrawer, { pool, view, onClose: () => {} }));
    const chartEpochs = (html: string) => [...html.matchAll(/aria-label="Settled volume, epoch (\d+):/g)].map(match => Number(match[1]));
    try {
      const initial = drawer();
      expect(chartEpochs(initial)).toEqual([15, 19, 21, 22]);
      state.data['pool:47214'] = { ...pool, currentEpoch: status === 'available' ? 23 : 24,
        volumes: status === 'available' ? [...pool.volumes].reverse() : [], volumeStatus: status };
      const refreshed = drawer();
      expect(chartEpochs(refreshed)).toEqual(chartEpochs(initial));
      expect(refreshed).toContain('21.42 USDC');
      expect(refreshed).toContain('0 USDC');
      expect(refreshed).toContain('Settled volume · completed epochs');
      expect(refreshed).toContain('Includes legacy seller activity.');
      expect(refreshed).not.toContain('View epoch data');
      expect(refreshed.includes('Showing previously loaded history.')).toBe(status !== 'available');
      expect(refreshed).not.toContain('<p class="hint">1,000 ANTS reference stake');
    } finally {
      if (previous === undefined) delete state.data['pool:47214'];
      else state.data['pool:47214'] = previous;
    }
  });

  it('keeps missing seller history unavailable instead of fabricating zero-volume epochs', () => {
    const previous = state.data['pool:47214'];
    const pool = { agentId: 47214, stakeable: true, hasPool: true, profile: null, activeStake: '0', weight: '0', powerShareBps: 0, lastEpochEmission: null, volumeStatus: 'unavailable', volumes: [] } as unknown as PoolView;
    state.data['pool:47214'] = { ...pool, currentEpoch: 23 };
    try {
      const view = { currentEpoch: 23, networkVolumes: [], explorer: null } as unknown as PoolsView;
      const html = render(createElement(PoolDrawer, { pool, view, onClose: () => {} }));
      expect(html).toContain('Settlement volume unavailable for completed epochs.');
      expect(html).not.toContain('volume-bar-row');
      expect(html).not.toContain('0 USDC');
    } finally {
      if (previous === undefined) delete state.data['pool:47214'];
      else state.data['pool:47214'] = previous;
    }
  });

  it('uses explorer ghost-rate percentage units without multiplying again', () => {
    const pool = { agentId: 1, stakeable: false, weight: '0', activeStake: '0', powerShareBps: 0, securityShareBps: 0, yourPower: '0', yourStake: '0', yourPositionIds: [], volumes: [], usagePoints: '0', weightedUsagePoints: '0', lastEpochUsagePoints: '0', lastEpochEmission: null, lastEpochRewardPer1kPower: null, projectedRewardPer1kPower: null, profile: { name: 'Seller', ghostRate: 12.4, providers: [] } } as unknown as PoolView;
    const view = { networkVolumes: [], explorer: 'https://antscan.co' } as unknown as PoolsView;
    const html = render(createElement(PoolDrawer, { pool, view, onClose: () => {} }));
    expect(html).toContain('12.4%');
    expect(html).not.toContain('1240');
    for (const removed of ['Security share', 'Reward / 1k power', 'Usage points (this / last)', 'Model revenue breakdown unavailable', 'Your positions', 'Weighted usage points']) expect(html).not.toContain(removed);
  });
});


describe('reward staking modal', () => {
  const rewardData = {
    buyerUsage: { total: '5000000000000000000', claimable: true },
    sellerUsage: { total: '0', claimable: false, agentId: 0 },
    staker: { total: '0', positions: [] },
  } as unknown as RewardsView;
  it.each([1, 52])('shows the APY for the selected amount at a %s-epoch lock', minStakeEpochs => {
    const app = { ...context, config: { ...context.config, readOnly: false }, overview: { ...context.overview, wallet: { eth: '1000000', canTransfer: false } } } as AppValue;
    const html = renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(StakeForm, {
      config: { minStakeEpochs, maxStakeEpochs: 104, restakedRewardWeightBonusBps: 0, stakeActivationDelay: 1, minEarlyExitSlashBps: 500, maxSlashBps: 5000, moveWeightPenaltyBps: 0 },
      pools: [{ agentId: 42, yield: { epoch: 20, startsAt: 0, endsAt: 604800, status: 'settled', reward: '1000000000000000000', power: '10000000000000000000000', minLockEpochs: 1, maxLockEpochs: 104 } }] as PoolView[],
      rewards: rewardData,
    })));
    const expected = formatYieldPercent(Math.expm1(Math.log1p(minStakeEpochs / (10000 + 5 * minStakeEpochs)) * (365 / 7)) * 100);
    expect(html).toContain(`Estimated APY <strong class="mono">${expected}</strong>`);
    expect(html).toContain('aria-label="About estimated APY"');
    expect(html).toContain('aria-label="About staking and early withdrawal"');
    expect(html).not.toContain('Based on');
    expect(html).not.toContain('compounding is not automatic');
    expect(html).not.toContain('Longer locks earn more staking power');
    expect(html).not.toContain('Stakes all eligible rewards from this source');
  });
  it('shows seller names without agent IDs and keeps an ID fallback for unnamed pools', () => {
    const app = { ...context, config: { ...context.config, readOnly: false }, overview: { ...context.overview, wallet: { eth: '1000000', canTransfer: false } } } as AppValue;
    const html = renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(StakeForm, {
      config: null, pools: [{ agentId: 42, profile: { name: ' Alpha ' } }, { agentId: 43 }] as PoolView[], rewards: rewardData,
    })));
    expect(html).toContain('<option value="42" selected="">Alpha</option>');
    expect(html).toContain('<option value="43">Agent ID 43</option>');
    expect(html).not.toContain('agent 42');
    expect(html).not.toContain('Fixed seller pool');
  });
  it.each([
    { kind: 'seller', lockedPool: false }, { kind: 'staker', lockedPool: false },
    { kind: 'seller', lockedPool: true }, { kind: 'staker', lockedPool: true },
  ])('keeps source-bound rewards in a fixed seller dropdown outside the seller sheet: %j', ({ kind, lockedPool }) => {
    const app = { ...context, config: { ...context.config, readOnly: false }, overview: { ...context.overview, wallet: { eth: '1000000', canTransfer: false } } } as AppValue;
    const rewards = {
      ...rewardData,
      buyerUsage: { ...rewardData.buyerUsage, total: '0' },
      sellerUsage: { ...rewardData.sellerUsage, total: kind === 'seller' ? '1000000000000000000' : '0', agentId: 42, claimable: true },
      staker: { total: '1000000000000000000', positions: kind === 'staker' ? [{ id: 25, agentId: 42, amount: '1000000000000000000', closed: false }] : [] },
    } as RewardsView;
    const html = renderToStaticMarkup(createElement(AppContext.Provider, { value: app }, createElement(StakeForm, {
      config: null, pools: [{ agentId: 42, profile: { name: 'Alpha' } }] as PoolView[], rewards, lockedPool, defaultAgentId: 42,
    })));
    expect(html).not.toContain('stake-destination');
    expect(html).not.toContain('Destination:');
    expect(html.match(/<select\b/g)).toHaveLength(lockedPool ? 1 : 2);
    if (lockedPool) expect(html).not.toContain('value="42"');
    else {
      expect(html).toMatch(/<select[^>]*disabled=""[^>]*><option value="42" selected="">Alpha<\/option><\/select>/);
      expect(html).toContain('These rewards can only be staked into this seller pool.');
    }
    expect(html).not.toContain('agent 42');
  });
  it('enables direct rewards while disabling restricted wallet balance', () => {
    const app = { ...context, config: { ...context.config, readOnly: false }, overview: { ...context.overview, wallet: { eth: '1000000', canTransfer: false } } } as AppValue;
    const html = renderToStaticMarkup(createElement(AppContext.Provider, {value: app}, createElement(StakeForm, {
      config: null, pools: [{ agentId: 42, name: 'Test pool' } as unknown as PoolView], balance: '1000000000000000000', rewards: rewardData,
    })));
    expect(html).toContain('Unclaimed buyer rewards');
    expect(html).toContain('<option value="buyer" selected="">Unclaimed buyer rewards · 5 ANTS</option>');
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain('AI buying rewards. Choose any seller; no claim needed.');
    // The restricted wallet balance is not offered at all, not merely disabled.
    expect(html).not.toContain('Wallet balance');
    expect(html).not.toContain('transfers restricted');
    expect(html).toContain('Rewards only: wallet ANTS transfers are disabled.');
    expect(html).not.toContain('Projected APY');
    expect(html).toContain('Estimated APY <strong class="mono">—</strong>');
    expect(html).not.toContain('Estimated first-epoch reward');
    expect(html).not.toContain('New stakes are unavailable');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Stake rewards/);
    expect(html).not.toContain('Review stake');
  });
  it('offers the wallet balance once transfers are enabled', () => {
    const app = { ...context, config: { ...context.config, readOnly: false }, overview: { ...context.overview, wallet: { eth: '1000000', canTransfer: true } } } as AppValue;
    const html = renderToStaticMarkup(createElement(AppContext.Provider, {value: app}, createElement(StakeForm, {
      config: null, pools: [{ agentId: 42 } as PoolView], balance: '1000000000000000000', rewards: rewardData,
    })));
    expect(html).toContain('Wallet balance');
    expect(html).toContain('<option value="wallet">Wallet balance · 1 ANTS</option>');
    expect(html).not.toContain('Rewards only: wallet ANTS transfers are disabled.');
  });
  it('explains the empty state under transfer restrictions instead of showing a disabled wallet row', () => {
    const app = { ...context, config: { ...context.config, readOnly: false }, overview: { ...context.overview, wallet: { eth: '1000000', canTransfer: false } } } as AppValue;
    const html = renderToStaticMarkup(createElement(AppContext.Provider, {value: app}, createElement(StakeForm, {
      config: null, pools: [{ agentId: 42 } as PoolView], balance: '1000000000000000000', rewards: { ...rewardData, buyerUsage: { total: '0', claimable: true } } as RewardsView,
    })));
    expect(html).toContain('Nothing to stake yet');
    expect(html).toContain('staking from the wallet balance is unavailable');
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain('Wallet balance');
  });
  it('hides staking sources until a browser wallet is connected', () => {
    const app = { ...context, config: { ...context.config, browserWallet: true, readOnly: true }, overview: { ...context.overview, wallet: { eth: '0', canTransfer: false } } } as AppValue;
    const html = renderToStaticMarkup(createElement(AppContext.Provider, {value: app}, createElement(StakeForm, {
      config: null, pools: [{ agentId: 42 } as PoolView], balance: '0', rewards: rewardData,
    })));
    expect(html).toContain('Connect your wallet to see what you can stake.');
    expect(html).not.toContain('Nothing to stake yet');
    expect(html).not.toContain('Unclaimed buyer rewards');
  });
  it('does not enable rewards belonging to another authorized wallet', () => {
    const app = { ...context, config: { ...context.config, readOnly: false }, overview: { ...context.overview, wallet: { eth: '1000000', canTransfer: false } } } as AppValue;
    const html = renderToStaticMarkup(createElement(AppContext.Provider, {value: app}, createElement(StakeForm, {
      config: null, pools: [{ agentId: 42 } as PoolView], rewards: {...rewardData, buyerUsage: {...rewardData.buyerUsage, claimable: false}},
    })));
    expect(html).toContain('Use the wallet button above to switch to the authorized wallet for these rewards.');
    expect(html).toContain('Unclaimed buyer rewards · other wallet');
    expect(html).not.toContain('>Connect wallet</button>');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});


describe('seller pool names', () => {
  it('uses the indexed seller name in selectors', () => {
    const pool = {agentId: 42, seller: '0x123', profile: {name: '  Alloy Compute  '}} as PoolView;
    expect(poolName(pool)).toBe('Alloy Compute');
    expect(poolLabel(pool)).toBe('Alloy Compute · agent 42');
  });
  it('uses an explicit pool identifier when the seller name is missing', () => {
    for (const name of [null, '', '   ']) {
      const pool = {agentId: 42, seller: '0x123', profile: {name}} as PoolView;
      expect(poolLabel(pool)).toBe('Seller pool #42');
    }
  });
});

describe('sidebar shell and pending stake', () => {
  const sellerPool = (overrides: Partial<PoolView>): PoolView => ({
    agentId: 7, seller: '0x00000000000000000000000000000000000000aa', profile: { name: 'Vault seller', providers: [], modelsServed: null, uniqueBuyers: null, requestCount: null, lifetimeVolumeUsdc: null, ghostRate: null, lastSettledAt: null },
    hasPool: true, stakeable: true, activeStake: '1000000000000000000000', weight: '1', powerShareBps: 100, securityShareBps: 0, volumes: [], volumeStatus: 'available',
    usagePoints: '0', weightedUsagePoints: '0', lastEpochUsagePoints: '0', lastEpochEmission: null, lastEpochEmissionSettled: false, lastEpochRewardPer1kPower: null, projectedRewardPer1kPower: null,
    yourStake: '0', yourPendingStake: '0', yourPower: '0', yourPoolShareBps: 0, yourPositionIds: [], ...overrides,
  });
  it('renders a left rail with grouped navigation, the active page marked, and the wallet at the bottom', () => {
    const html = render(createElement(Layout, { page: 'positions', updatedAt: null, loading: false, children: createElement('p', null, 'page body') }));
    expect(html).toContain('class="sidebar"');
    expect(html).not.toContain('class="topbar"');
    expect(html).toMatch(/<a href="#\/positions" class="sidenav-item active" aria-current="page">/);
    expect(html).toMatch(/<a href="#\/stake" class="sidenav-item">/);
    for (const label of ['Market', 'You', 'Protocol', 'Sellers', 'My positions', 'Rewards', 'Seller', 'Network', 'Addresses']) expect(html).toContain(label);
    expect(html.indexOf('sidebar-foot')).toBeGreaterThan(html.indexOf('class="sidenav"'));
    expect(html).toContain('page body');
  });
  it('routes the positions page directly and keeps old hashes redirecting', () => {
    expect(parseRoute('#/positions')).toMatchObject({ page: 'positions', redirected: false });
    expect(parseRoute('#/pools')).toMatchObject({ page: 'stake', redirected: true });
    expect(parseRoute('#/rewards')).toMatchObject({ page: 'rewards', redirected: false });
  });
  it('shows pending stake in the sellers table and counts it as yours', () => {
    const pending = sellerPool({ yourPendingStake: '250000000000000000000', pendingStake: '400000000000000000000' });
    const html = render(createElement(PoolsTable, { pools: [pending], currentEpoch: 22, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain('pending activation');
    expect(html).toContain('<span class="cell-stack pending-amount">250');
    expect(html).toContain('+400');
    expect(html).toContain('my pools · 1');
    const mixed = render(createElement(PoolsTable, { pools: [sellerPool({ yourStake: '100000000000000000000', yourPendingStake: '5000000000000000000', yourPoolShareBps: 1000 })], currentEpoch: 22, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(mixed).toContain('+5');
    expect(mixed).not.toContain('of pool');
  });
  it('keeps the seller list visible while your stake waits for Antscan', () => {
    const previousPools = state.data.pools;
    state.data.pools = { source: 'indexer', sourceError: null, walletSyncing: true, pools: [sellerPool({ yourStake: '100000000000000000000', yourPositionIds: [1] })], networkVolumes: [], currentEpoch: 22 };
    state.reconcilingPools = true;
    try {
      const html = render(createElement(StakePage));
      expect(html).toContain('Updating your stake…');
      expect(html).not.toContain('>Refresh<');
      expect(html).toContain('Vault seller');
      expect(html).not.toContain('>100<');
      expect(html).toContain('Updating…');
      expect(html).not.toContain('my pools');
      expect(html).not.toContain('No sellers are ready');
    } finally { state.data.pools = previousPools; state.reconcilingPools = false; }
  });

  it('hides your seller-sheet figures while they wait for Antscan', () => {
    const view = { currentEpoch: 22, networkVolumes: [], explorer: null, walletSyncing: true } as unknown as PoolsView;
    const html = render(createElement(PoolDrawer, { pool: sellerPool({ yourStake: '0', yourPendingStake: '5000000000000000000' }), view, onClose: () => {} }));
    expect(html).toContain('Waiting for Antscan to include your latest transaction');
    expect(html).not.toContain('Pending stake starts earning');
  });
  it('lists pending stake in the seller sheet and links to the positions page', () => {
    const view = { currentEpoch: 22, networkVolumes: [], explorer: null } as unknown as PoolsView;
    const html = render(createElement(PoolDrawer, { pool: sellerPool({ yourStake: '100000000000000000000', yourPendingStake: '5000000000000000000', pendingStake: '9000000000000000000' }), view, onClose: () => {} }));
    expect(html).toContain('Pending activation');
    expect(html).toContain('+9');
    expect(html).toContain('href="#/positions"');
  });
  it('resolves hover slots and nearest points for chart tooltips', () => {
    expect(slotIndex(59, 60, 20, 5)).toBeNull();
    expect(slotIndex(60, 60, 20, 5)).toBe(0);
    expect(slotIndex(99.9, 60, 20, 5)).toBe(1);
    expect(slotIndex(160, 60, 20, 5)).toBeNull();
    expect(slotIndex(70, 60, 0, 5)).toBeNull();
    expect(nearestIndex(12, [0, 10, 20])).toBe(1);
    expect(nearestIndex(-100, [0, 10, 20])).toBe(0);
    expect(nearestIndex(5, [])).toBeNull();
    expect(nearestIndex(5, [Number.POSITIVE_INFINITY, 4])).toBe(1);
  });
  it('gives sparklines a hover readout only when point labels are supplied', () => {
    const pool = sellerPool({ volumes: [{ epoch: 21, usdc: '2000000' }, { epoch: 20, usdc: '1000000' }, { epoch: 19, usdc: '500000' }] });
    const html = render(createElement(PoolsTable, { pools: [pool], currentEpoch: 22, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain('class="sparkline-wrap"');
    expect(html).not.toContain('chart-tip');
  });
});
