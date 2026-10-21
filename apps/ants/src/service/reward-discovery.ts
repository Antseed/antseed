import { ZeroAddress } from 'ethers';
import { latestClaimableEpoch, type EpochRange, type EpochReward } from '@antseed/node';
import type { AntsContext } from './context.js';

/**
 * On-chain discovery of payable referral, invite-bonus and builders rewards,
 * for when no explorer says which epochs are payable. Rewards do not expire
 * (an epoch is claimable from a minimum age on, and an epoch with claimants
 * keeps its bucket), so the scan reaches back to the first epoch the program
 * can pay: its emissions gate's `effectiveEpoch`, or for an invite bonus the
 * epoch the buyer was bound in. Each RPC batch reads at most
 * `DISCOVERY_BATCH_EPOCHS` epochs; batches run one after another.
 */

/** Epochs read at once (one `pending*Reward` call each). */
export const DISCOVERY_BATCH_EPOCHS = 26;

export interface DiscoveredRewards {
  /** Epochs with a non-zero payable reward, oldest first. */
  epochs: number[];
  /** Their total, in ANTS base units. */
  payable: string;
}

const NOTHING: DiscoveredRewards = { epochs: [], payable: '0' };

interface RewardsProgram {
  currentEpoch(): Promise<number>;
  firstRewardEpoch(): Promise<number>;
}

/** The program's first payable epoch; the chain config's recognized-usage epoch (or 0) when the gate cannot be read. */
async function firstEpoch(ctx: AntsContext, program: RewardsProgram): Promise<number> {
  return program.firstRewardEpoch().catch(() => ctx.chain.recognizedUsage?.effectiveEpoch ?? 0);
}

/** Page back from `latest` to `floor` in bounded batches, collecting every payable epoch. */
async function scanBack(floor: number, latest: number, read: (range: Required<EpochRange>) => Promise<EpochReward[]>): Promise<DiscoveredRewards> {
  const found: EpochReward[] = [];
  for (let toEpoch = latest; toEpoch >= floor; toEpoch -= DISCOVERY_BATCH_EPOCHS) {
    const fromEpoch = Math.max(floor, toEpoch - DISCOVERY_BATCH_EPOCHS + 1);
    found.unshift(...await read({ fromEpoch, toEpoch }));
  }
  return found.length === 0 ? NOTHING : {
    epochs: found.map((entry) => entry.epoch),
    payable: found.reduce((sum, entry) => sum + entry.amount, 0n).toString(),
  };
}

/** Every epoch with a payable referral reward for `referrer` (the dashboard wallet by default). */
export async function discoverReferrerEpochs(ctx: AntsContext, referrer: string = ctx.address): Promise<DiscoveredRewards> {
  const client = ctx.referrals();
  if (!client) throw new Error('Referrals are not configured for this chain.');
  const [floor, current] = await Promise.all([firstEpoch(ctx, client), client.currentEpoch()]);
  return scanBack(floor, latestClaimableEpoch(current), (range) => client.pendingRewards(referrer, range));
}

/**
 * Every epoch with a payable invite bonus for `buyer` (the buyer account by
 * default), from the epoch it was bound in. Nothing for an unbound buyer.
 */
export async function discoverRefereeEpochs(ctx: AntsContext, buyer: string = ctx.buyerAddress): Promise<DiscoveredRewards> {
  const client = ctx.referrals();
  if (!client) throw new Error('Referrals are not configured for this chain.');
  const binding = await client.referralOf(buyer);
  if (binding.referrer === ZeroAddress) return NOTHING;
  const [floor, current] = await Promise.all([firstEpoch(ctx, client), client.currentEpoch()]);
  return scanBack(Math.max(floor, binding.epoch), latestClaimableEpoch(current), (range) => client.pendingRefereeRewards(buyer, range));
}

/** Every epoch with a payable builders reward for client agent `agentId`. */
export async function discoverBuilderEpochs(ctx: AntsContext, agentId: number): Promise<DiscoveredRewards> {
  const client = ctx.clientRewards();
  if (!client) throw new Error('The builders program is not configured for this chain.');
  const [floor, current] = await Promise.all([firstEpoch(ctx, client), client.currentEpoch()]);
  return scanBack(floor, latestClaimableEpoch(current), (range) => client.pendingRewards(agentId, range));
}
