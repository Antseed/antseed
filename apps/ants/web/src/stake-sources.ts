import type { RewardsView, RestakeRequest, StakeRequest, StakeUsageRequest } from '../../src/api-types';

export interface StakeSource {
  id: string;
  kind: 'wallet' | 'buyer' | 'seller' | 'staker';
  label: string;
  amount: string;
  available: boolean;
  agentId?: number;
  positionId?: number;
}

/**
 * Sources an ANTS stake can come from. Legacy/locked rewards deliberately have
 * no direct staking route. The wallet balance is only offered while the wallet
 * can transfer ANTS: with transfers restricted, staking happens from rewards
 * alone, so the wallet is not listed at all rather than shown disabled.
 */
export function stakeSources(rewards: RewardsView | null, balance: string, canTransfer: boolean): StakeSource[] {
  const sources: StakeSource[] = [];
  if (rewards) {
    if (BigInt(rewards.buyerUsage.total) > 0n) sources.push({ id: 'buyer', kind: 'buyer', label: 'Unclaimed buyer rewards', amount: rewards.buyerUsage.total, available: rewards.buyerUsage.claimable });
    if (BigInt(rewards.sellerUsage.total) > 0n) sources.push({ id: 'seller', kind: 'seller', label: 'Unclaimed seller rewards', amount: rewards.sellerUsage.total, available: rewards.sellerUsage.claimable, agentId: rewards.sellerUsage.agentId });
    for (const position of rewards.staker.positions) {
      if (BigInt(position.amount) > 0n) sources.push({ id: `staker:${position.id}`, kind: 'staker', label: `Staking rewards · position #${position.id}`, amount: position.amount, available: true, agentId: position.agentId, positionId: position.id });
    }
  }
  if (canTransfer) sources.push({ id: 'wallet', kind: 'wallet', label: 'Wallet balance', amount: balance, available: true });
  return sources;
}

export function stakeSourceRequest(source: StakeSource, agentId: number, amount: string, epochs: number): { path: string; body: StakeRequest | StakeUsageRequest | RestakeRequest } {
  if (!source.available) throw new Error('This staking source is unavailable.');
  if (source.agentId !== undefined && source.agentId !== agentId) throw new Error('These rewards must be staked into their source pool.');
  if (source.kind === 'wallet') return { path: '/api/positions/stake', body: { agentId, amount, epochs } };
  if (source.kind === 'staker') return { path: '/api/rewards/restake', body: { positionIds: [source.positionId!], epochs } };
  return { path: '/api/rewards/stake-usage', body: { side: source.kind, epochs, ...(source.kind === 'buyer' ? { stakeAgentId: agentId } : {}) } };
}
