import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolView, RewardsView } from '../../src/api-types';
import { AppContext, type AppValue } from './app-context';
import type { ActionButtonProps } from './components/Confirm';
import { RewardsPage } from './pages/Rewards';

const state = vi.hoisted(() => ({ rewards: null as RewardsView | null, pools: [] as PoolView[], actions: [] as ActionButtonProps[], configReady: true, configLoading: false, configError: null as string | null, rewardsLoading: false, rewardsError: null as string | null, reconciling: false }));
vi.mock('./data', () => ({ usePageData: (key: string | null) => ({
  data: key === 'rewards' ? state.rewards : key === 'pools' ? { pools: state.pools } : key === 'positions:current' && state.configReady ? { config: { minStakeEpochs: 1, maxStakeEpochs: 104, stakeActivationDelay: 1 } } : null,
  error: key === 'rewards' ? state.rewardsError : key === 'positions:current' ? state.configError : null,
  loading: key === 'rewards' ? state.rewardsLoading : key === 'positions:current' && state.configLoading,
  reconciling: key === 'rewards' && state.reconciling,
  refresh: () => {},
}) }));
vi.mock('./wallet', () => ({ BuyerWalletAction: () => null }));
vi.mock('./components/Confirm', () => ({ ActionButton: (props: ActionButtonProps) => {
  state.actions.push(props);
  return createElement('button', { disabled: props.disabled }, props.label);
} }));

const wallet = '0x0000000000000000000000000000000000000001';
const buyer = '0x0000000000000000000000000000000000000002';
const pool = '0x0000000000000000000000000000000000000003';
const ants = (amount: number) => (BigInt(amount) * 10n ** 18n).toString();
const context = {
  config: { address: wallet, buyerAddress: buyer, chainId: 'base-mainnet', evmChainId: 8453, readOnly: false },
  overview: { epoch: { current: 23, genesis: 1775728461, epochDuration: 604800 }, wallet: { canTransfer: false, eth: ants(1) } },
} as AppValue;

function render() {
  return renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, createElement(RewardsPage)));
}

function summary(action: ActionButtonProps) {
  return renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, createElement('div', null, action.summary!.map(([label, value]) => createElement('div', { key: label }, label, value)))));
}

function action(title: string) {
  const found = state.actions.find((entry) => entry.title === title);
  expect(found).toBeDefined();
  return found!;
}

beforeEach(() => {
  state.actions = [];
  state.pools = [];
  state.configReady = true;
  state.configLoading = false;
  state.configError = null;
  state.rewardsLoading = false;
  state.rewardsError = null;
  state.reconciling = false;
  state.rewards = {
    scope: 'all', currentEpoch: 23, firstRewardedEpoch: 22, total: ants(2200),
    staker: { total: ants(100), positions: [] },
    sellerUsage: { total: ants(150), agentId: 42, epochs: [], claimable: true },
    buyerUsage: { total: ants(250), epochs: [], operator: wallet, recipient: wallet, claimable: true },
    legacy: { seller: ants(600), buyer: ants(1000), contract: pool, buyerClaimable: true, sellerPayout: { destination: 'locked', recipient: pool } },
    locked: { locked: ants(1000), claimable: ants(100), policy: pool, pool },
  };
});

describe('reward row actions and confirmations', () => {
  it('omits the buyer action row when no authorization or connection action is available', () => {
    state.rewards!.scope = 'buyer';
    state.rewards!.buyerUsage.operator = null;
    expect(render()).not.toContain('class="hero-actions"');
  });

  it('keeps the buyer authorization action when available', () => {
    state.rewards!.scope = 'buyer';
    state.rewards!.buyerUsage.operator = null;
    const authorizationContext = { ...context, config: { ...context.config, canAuthorize: true } };
    const html = renderToStaticMarkup(createElement(AppContext.Provider, { value: authorizationContext }, createElement(RewardsPage)));
    expect(html).toContain('class="hero-actions"');
    expect(html).toContain('Authorize wallet');
  });

  it('shows seller names in the staking dropdown and falls back to agent IDs when names are missing', () => {
    state.pools = [
      { agentId: 42, profile: { name: ' Seller Alpha ' } },
      { agentId: 43, profile: { name: 'Seller Beta' } },
      { agentId: 44, profile: { name: ' ' } },
    ] as PoolView[];
    render();
    const stake = action('Stake current buyer rewards');
    const controls = renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, stake.children));
    const options = [...controls.matchAll(/<option\b([^>]*)>(.*?)<\/option>/g)];
    expect(options.map(option => option[2])).toEqual(['Seller Alpha', 'Seller Beta', 'Agent ID 44']);
    expect(options.map(option => option[1])).toEqual([
      expect.stringContaining('value="42"'),
      expect.stringContaining('value="43"'),
      expect.stringContaining('value="44"'),
    ]);
    expect(stake.body).toMatchObject({ side: 'buyer', stakeAgentId: 42 });
  });

  it('uses the connected operator rather than the selected buyer to enable buyer rewards', () => {
    const selectedContext = { ...context, config: { ...context.config, address: buyer, selectedAddress: buyer, walletAddress: wallet } };
    renderToStaticMarkup(createElement(AppContext.Provider, { value: selectedContext }, createElement(RewardsPage)));
    expect(action('Claim current buyer rewards').disabled).toBe(false);
    expect(action('Claim legacy buyer rewards').disabled).toBe(false);
  });
  it('shows unavailable staking rewards without a false zero or disabling buyer claims', () => {
    state.rewards!.staker = { total: null, positions: [], source: { error: 'Antscan snapshot is incomplete' } };
    state.rewards!.total = null;
    const html = render();
    expect(html).toContain('Staking rewards unavailable: Antscan snapshot is incomplete');
    expect(html).not.toContain('Nothing to claim yet');
    expect(state.actions.some(entry => entry.title === 'Stake position rewards')).toBe(false);
    expect(action('Claim current buyer rewards').disabled).toBe(false);
  });

  it('labels the staking reward checkpoint and retains live transaction validation', () => {
    state.rewards!.staker.source = { indexedBlock: 123 };
    expect(render()).toContain('Estimated by Antscan at block 123. Claims and restaking are checked live.');
  });
  it('shows reward destinations by seller name and sums rewards within each pool', () => {
    state.pools = [
      { agentId: 42, profile: { name: 'Seller Alpha' } },
      { agentId: 43, profile: { name: 'Seller Beta' } },
    ] as PoolView[];
    state.rewards!.staker.positions = [
      { id: 1, agentId: 42, amount: ants(40), closed: false },
      { id: 2, agentId: 42, amount: ants(30), closed: true },
      { id: 3, agentId: 43, amount: ants(30), closed: false },
      { id: 4, agentId: 44, amount: '0', closed: false },
    ];
    render();
    const stake = action('Stake position rewards');
    const detail = summary(stake);
    expect(detail).toContain('Seller Alpha · 70 ANTS');
    expect(detail).toContain('Seller Beta · 30 ANTS');
    expect(detail).not.toContain('same pools');
    expect(detail).not.toContain('Seller pool #44');
    expect(stake.path).toBe('/api/rewards/restake');
    expect(stake.body).toEqual({ epochs: 104 });
    expect(summary(action('Stake current seller rewards'))).toContain('Seller Alpha');
  });
  it('uses an explicit pool identifier when the destination name is unavailable', () => {
    state.rewards!.staker.positions = [{ id: 1, agentId: 42, amount: ants(100), closed: false }];
    render();
    expect(summary(action('Stake position rewards'))).toContain('Seller pool #42 · 100 ANTS');
    expect(summary(action('Stake position rewards'))).not.toContain('same pools');
  });
  it('keeps amounts visible during background refreshes before transaction confirmation', () => {
    state.rewardsLoading = true;
    const html = render();
    expect(html).not.toContain('reward-amount-loading');
    expect(html).not.toContain('Out of date');
    expect(html).toContain('class="hero-value">1,250<span');
    expect(action('Claim current buyer rewards').disabled).toBe(false);
  });
  it.each([true, false])('keeps amounts visible and marks them updating until reconciliation completes (loading: %s)', loading => {
    state.rewardsLoading = loading;
    state.reconciling = true;
    const html = render();
    expect(html).toContain('Updating…');
    expect(html).not.toContain('reward-amount-loading');
    expect(html).not.toContain('Rewards could not be refreshed');
    expect(html).toContain('<span class="muted" aria-busy="true">1,250</span>');
    expect(html).toContain('<span class="muted" aria-busy="true">100</span>');
    expect(html).toContain('<span class="muted" aria-busy="true">850</span>');
    expect(html).not.toContain('skel-list');
    expect(state.actions.length).toBeGreaterThan(0);
    for (const entry of state.actions) {
      expect(entry.disabled).toBe(true);
      expect(entry.label).not.toBe('Updating…');
    }
    expect(action('Claim current buyer rewards').label).toBe('Claim to wallet');
    expect(action('Stake current buyer rewards').label).toBe('Stake rewards');
    expect(action('Claim legacy seller rewards').label).toBe('Claim not available yet');
    expect(action('Withdraw released seller rewards').label).toBe('Withdraw available amount');
  });
  it('shows refreshed amounts and restores eligible actions after refresh', () => {
    state.rewardsLoading = true;
    state.reconciling = true;
    render();
    state.rewardsLoading = false;
    state.reconciling = false;
    state.rewards!.buyerUsage.total = '0';
    state.actions = [];
    const html = render();
    expect(html).not.toContain('Updating…');
    expect(html).not.toContain('reward-refresh-state');
    expect(html).not.toContain('reward-amount-loading');
    expect(html).toContain('class="hero-value">1,000<span');
    expect(action('Claim current buyer rewards').disabled).toBe(true);
    expect(action('Claim legacy buyer rewards').disabled).toBe(false);
    expect(action('Stake current seller rewards').disabled).toBe(false);
  });
  it('marks amounts stale and offers retry without suggesting the transaction failed', () => {
    state.rewardsError = 'RPC unavailable';
    state.reconciling = true;
    const html = render();
    expect(html).toContain('Rewards could not be refreshed');
    expect(html).toContain('This does not mean a confirmed transaction failed.');
    expect(html).toContain('Retry');
    expect(html.match(/Out of date/g)).toHaveLength(3);
    expect(html).toContain('class="hero-value">1,250<span');
    expect(state.actions.every(entry => entry.disabled)).toBe(true);
    state.rewardsLoading = true;
    const retrying = render();
    expect(retrying).toContain('Updating…');
    expect(retrying).not.toContain('skeleton reward-amount-loading');
    expect(retrying).not.toContain('Updating rewards…');
    expect(retrying).not.toContain('Out of date');
    expect(retrying).not.toContain('Rewards could not be refreshed');
  });
  it('uses the initial skeleton rather than displaying old amounts when no rewards are loaded', () => {
    state.rewards = null;
    state.rewardsLoading = true;
    const html = render();
    expect(html).toContain('skel-list');
    expect(html).not.toContain('Updating rewards…');
    expect(state.actions).toHaveLength(0);
  });
  it('shows disabled loading buttons until staking configuration is ready', () => {
    state.configReady = false;
    state.configLoading = true;
    const html = render();
    expect(html.match(/aria-busy="true"/g)).toHaveLength(3);
    expect(html.match(/disabled="" aria-busy="true"/g)).toHaveLength(3);
    expect(html).not.toContain('Pool configuration is still loading.');
    expect(state.actions.every(entry => entry.path === '/api/rewards/claim')).toBe(true);
    state.configReady = true;
    state.configLoading = false;
    state.actions = [];
    expect(render()).not.toContain('aria-busy="true"');
    for (const title of ['Stake current buyer rewards', 'Stake current seller rewards', 'Stake position rewards']) {
      expect(action(title).label).toBe('Stake rewards');
      expect(action(title).disabled).toBe(false);
    }
  });
  it('offers retry rather than perpetual loading when configuration fails', () => {
    state.configReady = false;
    state.configError = 'Network error';
    const html = render();
    expect(html.match(/Retry loading/g)).toHaveLength(3);
    expect(html).not.toContain('aria-busy="true"');
    expect(state.actions.every(entry => entry.path === '/api/rewards/claim')).toBe(true);
    state.configLoading = true;
    expect(render().match(/aria-busy="true"/g)).toHaveLength(3);
  });
  it('does not block staking on background configuration refreshes with cached data', () => {
    state.configLoading = true;
    expect(render()).not.toContain('aria-busy="true"');
    expect(action('Stake current buyer rewards').disabled).toBe(false);
  });
  it.each([true, false])('uses short reward definitions rather than eligibility messages (eligible: %s)', (eligible) => {
    if (!eligible) {
      state.rewards!.buyerUsage.total = '0';
      state.rewards!.buyerUsage.claimable = false;
      state.rewards!.sellerUsage.claimable = false;
      state.rewards!.legacy.sellerPayout = { destination: 'unknown', recipient: null };
      state.rewards!.locked.policy = null;
      state.rewards!.locked.claimable = '0';
    }
    const html = render();
    const descriptions = [...html.matchAll(/<div class="bucket-note">([^<]*)<\/div>/g)].map((match) => match[1]);
    expect(descriptions).toEqual([
      'Earned from using AI services.',
      'Earned from using AI services under the previous rewards system.',
      'Earned from providing AI services.',
      'Earned from providing AI services under the previous rewards system.',
      'Past seller rewards held in the locked pool.',
    ]);
  });
  it('keeps staking and seller totals and actions in separate sections', () => {
    state.rewards!.historySource = 'chain';
    const html = render();
    const staking = html.slice(html.indexOf('aria-label="Staking rewards"'), html.indexOf('aria-label="Seller rewards"'));
    const seller = html.slice(html.indexOf('aria-label="Seller rewards"'));
    expect(staking).toContain('class="hero-value">100<span');
    expect(seller).toContain('class="hero-value">850<span');
    expect(staking).toContain('Closed-position history is unavailable');
    expect(seller).not.toContain('Closed-position history is unavailable');
    expect(staking).not.toContain('Current seller rewards');
    expect(seller).not.toContain('Staking rewards');
    expect(seller).toContain('Available to stake directly <span class="mono">150</span>');
    expect(seller).toContain('other rewards <span class="mono">700</span>');
    expect(staking).toContain('100');
    expect(seller).toContain('600');
    expect(action('Claim staking rewards').body).toEqual({ buckets: ['staker'], scope: 'wallet' });
  });
  it('shows independent empty states and retains unreleased seller balances', () => {
    state.rewards!.staker.total = '0';
    state.rewards!.sellerUsage.total = '0';
    state.rewards!.legacy.seller = '0';
    state.rewards!.locked.claimable = '0';
    const html = render();
    expect(html.match(/Nothing to claim yet/g)).toHaveLength(2);
    expect(html).toContain('1,000 ANTS locked');
    expect(state.actions.some((entry) => entry.title === 'Claim staking rewards')).toBe(false);
    expect(action('Withdraw released seller rewards').disabled).toBe(true);
  });
  it('keeps nonclaimable current seller rewards out of the direct-staking subtotal', () => {
    state.rewards!.sellerUsage.claimable = false;
    const html = render();
    const seller = html.slice(html.indexOf('aria-label="Seller rewards"'));
    expect(seller).toContain('class="hero-value">850<span');
    expect(seller).toContain('Available to stake directly <span class="mono">0</span>');
    expect(seller).toContain('other rewards <span class="mono">850</span>');
    expect(action('Stake current seller rewards').disabled).toBe(true);
  });
  it('does not expose seller or staking sections in buyer-only scope', () => {
    state.rewards!.scope = 'buyer';
    const html = render();
    expect(html).toContain('Buyer rewards');
    expect(html).not.toContain('aria-label="Seller rewards"');
    expect(html).not.toContain('aria-label="Staking rewards"');
  });
  it('does not construct unused confirmation summaries for direct claims', () => {
    render();
    for (const claim of state.actions.filter(entry => entry.path === '/api/rewards/claim')) {
      expect(claim.summary).toBeUndefined();
      expect(claim.children).toBeUndefined();
    }
  });
  it('separates current and legacy buyer claims and shows their individual amounts', () => {
    const html = render();
    expect(html).toContain('Current buyer rewards');
    expect(html).toContain('Legacy buyer rewards');
    expect(html).toContain('aria-label="Seller rewards"');
    expect(html).toContain('aria-label="Staking rewards"');
    expect(html).not.toContain('Seller &amp; staking rewards');
    expect(html).not.toContain('Wallet rewards');
    expect(action('Claim current buyer rewards').body).toEqual({ buckets: ['buyer'], scope: 'buyer' });
    expect(action('Claim legacy buyer rewards').body).toEqual({ buckets: ['legacy'], scope: 'buyer' });
    expect(html).toContain('250');
    expect(html).toContain('1,000');
  });
  it('keeps only the amount summary above the buyer staking controls', () => {
    render();
    const stake = action('Stake current buyer rewards');
    expect(stake.summary!.map(([label]) => label)).toEqual(['Amount']);
    expect(summary(stake)).toContain('250 ANTS');
    const controls = renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, stake.children));
    expect(controls).toContain('type="range"');
    expect(controls).toContain('Lock');
    expect(controls).toContain('Pool');
    expect(controls).toContain('<select');
    expect(stake.body).toMatchObject({ side: 'buyer', stakeAgentId: 42, epochs: expect.any(Number) });
  });
  it('uses consistent staking labels without offering legacy staking', () => {
    render();
    const staking = state.actions.filter((entry) => entry.path !== '/api/rewards/claim');
    expect(staking).toHaveLength(3);
    for (const entry of staking) expect(entry.label).toBe('Stake rewards');
    expect(action('Stake current buyer rewards').body).toMatchObject({ side: 'buyer' });
    expect(action('Stake current seller rewards').body).toMatchObject({ side: 'seller' });
    expect(action('Stake position rewards').path).toBe('/api/rewards/restake');
    expect(state.actions.some((entry) => entry.path === '/api/rewards/compound')).toBe(false);
    expect(state.actions.some((entry) => entry.title?.includes('Stake legacy'))).toBe(false);
  });
  it('disables buyer actions when the connected wallet is not authorized', () => {
    state.rewards!.buyerUsage.operator = buyer;
    state.rewards!.buyerUsage.claimable = false;
    state.rewards!.legacy.buyerClaimable = false;
    render();
    expect(action('Claim current buyer rewards').disabled).toBe(true);
    expect(action('Claim legacy buyer rewards').disabled).toBe(true);
    expect(state.actions.some((entry) => entry.title === 'Stake current buyer rewards')).toBe(false);
  });
  it.each(['wallet', 'locked', 'unknown', 'missing'] as const)('preserves legacy seller destination safeguards: %s', (destination) => {
    state.rewards!.legacy.sellerPayout = destination === 'missing' ? undefined : { destination, recipient: destination === 'wallet' ? wallet : destination === 'locked' ? pool : null };
    render();
    const claim = action('Claim legacy seller rewards');
    if (destination === 'unknown' || destination === 'missing') {
      expect(claim.disabled).toBe(true);
      expect(claim.label).toBe('Claim unavailable');
      expect(claim.disabledReason).toContain('Payout destination could not be verified');
    } else {
      expect(claim.disabled).toBe(destination === 'locked');
      expect(claim.label).toBe(destination === 'locked' ? 'Claim not available yet' : 'Claim to wallet');
      if (destination === 'locked') expect(claim.disabledReason).toContain('currently unavailable in this dashboard');
      expect(claim.body).toEqual({ buckets: ['legacy'], scope: 'wallet', expectedLegacySellerRecipient: destination === 'locked' ? pool : wallet });
    }
  });
  it('keeps locked rewards visible and submits the available withdrawal directly', () => {
    const html = render();
    const withdraw = action('Withdraw released seller rewards');
    expect(withdraw.disabled).toBe(false);
    expect(withdraw.label).toBe('Withdraw available amount');
    expect(withdraw.body).toEqual({ buckets: ['locked'], scope: 'wallet' });
    expect(html).toContain('Locked seller rewards');
    expect(html).toContain('1,000 ANTS locked');
    expect(html).toContain('100');
    expect(withdraw.summary).toBeUndefined();
  });
  it('disables withdrawals without a release policy', () => {
    state.rewards!.locked.policy = null;
    state.rewards!.locked.claimable = '0';
    render();
    expect(action('Withdraw released seller rewards').disabled).toBe(true);
  });
});
