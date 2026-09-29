import { describe, expect, it } from 'vitest';
import type { RewardsView } from '../../src/api-types';
import { stakeSources, stakeSourceRequest } from './stake-sources';

const rewards = {
  buyerUsage: { total: '100', claimable: true },
  sellerUsage: { total: '200', claimable: true, agentId: 42 },
  staker: { total: '300', positions: [{ id: 7, agentId: 43, amount: '300', closed: true }] },
  legacy: { seller: '400', buyer: '500' },
  locked: { locked: '1000', claimable: '100' },
} as RewardsView;

describe('stake sources under transfer restrictions', () => {
  it('offers direct rewards including closed-position rewards, without legacy rewards or the restricted wallet', () => {
    const sources = stakeSources(rewards, '600', false);
    expect(sources.map(s => [s.id, s.available])).toEqual([['buyer', true], ['seller', true], ['staker:7', true]]);
    expect(sources.map(s => s.amount)).toEqual(['100', '200', '300']);
  });
  it('lists the wallet last once transfers are enabled', () => {
    const sources = stakeSources(rewards, '600', true);
    expect(sources.map(s => [s.id, s.available])).toEqual([['buyer', true], ['seller', true], ['staker:7', true], ['wallet', true]]);
    expect(sources.at(-1)?.amount).toBe('600');
  });
  it('routes buyer rewards to the selected pool without a wallet transfer', () => {
    expect(stakeSourceRequest(stakeSources(rewards, '0', false)[0]!, 99, '100', 4)).toEqual({path: '/api/rewards/stake-usage', body: { side: 'buyer', stakeAgentId: 99, epochs: 4 }});
  });
  it('keeps seller and position rewards in their required pools', () => {
    const sources = stakeSources(rewards, '0', false);
    expect(stakeSourceRequest(sources[1]!, 42, '200', 4)).toEqual({path: '/api/rewards/stake-usage', body: {side: 'seller', epochs: 4}});
    expect(stakeSourceRequest(sources[2]!, 43, '300', 4)).toEqual({path: '/api/rewards/restake', body: {positionIds: [7], epochs: 4}});
    expect(() => stakeSourceRequest(sources[1]!, 99, '200', 4)).toThrow('source pool');
  });
  it('blocks unauthorized buyer rewards and never lists restricted wallet tokens', () => {
    const sources = stakeSources({...rewards, buyerUsage: {...rewards.buyerUsage, claimable: false}}, '100', false);
    expect(() => stakeSourceRequest(sources[0]!, 99, '100', 4)).toThrow('unavailable');
    expect(sources.some(s => s.kind === 'wallet')).toBe(false);
  });
  it('preserves wallet staking when transfers are permitted', () => {
    const source = stakeSources(null, '100', true)[0]!;
    expect(stakeSourceRequest(source, 42, '0.5', 4)).toEqual({path: '/api/positions/stake', body: {agentId: 42, amount: '0.5', epochs: 4}});
  });
});
