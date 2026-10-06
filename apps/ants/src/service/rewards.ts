import { ZeroAddress } from 'ethers';
import { claimEpochRewards, pendingEpochRewards, previewPoolRewards, type SellerPoolsClient, type SellerPoolsRewardsClient } from '@antseed/node/payments';
import { indexedWalletRewards } from './indexed-wallet.js';
import { IndexerSyncingError } from '../read-state.js';
import type { AbstractSigner } from 'ethers';
import type { AntsContext } from './context.js';
import { closedPositionIds } from './positions.js';
import { legacySellerPayout } from './legacy-payout.js';
import { IndexerError } from './indexer.js';
import type { RewardsView, ClaimRequest, RestakeRequest, StakeUsageRequest, EpochAmount, RewardBucket } from '../api-types.js';
import { formatAnts } from './format.js';
import { toJson } from './json.js';
import { assertAgentId, assertEpochs, assertPositiveIds, silentReporter, type StepReporter } from './steps.js';

const MAX_EPOCH_BREAKDOWN = 64;


function sameAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

async function agentIdOf(ctx: AntsContext): Promise<number> {
  const stack = await ctx.stack();
  const registry = ctx.sellerRegistry();
  const fromRegistry = registry ? await registry.getAgentId(ctx.address) : 0;
  if (fromRegistry) return fromRegistry;
  const legacy = ctx.legacyStakingAt(stack.legacyStaking);
  return legacy ? legacy.getAgentId(ctx.address) : 0;
}

/** Recognized epochs in which this wallet has indexed buyer or seller points; all of them without an indexer. */
async function usageEpochsOf(ctx: AntsContext, recognized: number[], currentEpoch: number): Promise<number[]> {
  const indexer = ctx.indexer();
  if (!indexer || recognized.length === 0) return recognized;
  // The indexer counts epochs back from the current one, so the window must reach the earliest recognized epoch.
  const window = currentEpoch - Math.min(...recognized) + 1;
  try {
    const participant = sameAddress(ctx.address, ZeroAddress)
      ? { seller: [], buyer: [] }
      : await indexer.participant(ctx.address, window);
    const buyer = ctx.address.toLowerCase() === ctx.buyerAddress.toLowerCase() ? participant : await indexer.participant(ctx.buyerAddress, window);
    const active = new Set([...participant.seller.map((row) => row.epoch), ...buyer.buyer.map((row) => row.epoch)]);
    return recognized.filter((epoch) => active.has(epoch));
  } catch (error) {
    if (error instanceof IndexerError) return recognized;
    throw error;
  }
}

async function buyerOperator(ctx: AntsContext): Promise<string | null> {
  const deposits = ctx.deposits();
  if (!deposits) return null;
  const operator = await deposits.getOperator(ctx.buyerAddress);
  return sameAddress(operator, ZeroAddress) ? null : operator;
}

export async function rewards(ctx: AntsContext): Promise<RewardsView> {
  const stack = await ctx.stack();
  const epochs = await ctx.claimableEpochs();
  const pools = ctx.pools();
  const poolRewards = ctx.poolRewards();
  const usageAccounting = ctx.usageAccounting();
  const usageRewards = ctx.usageRewards();
  const legacy = ctx.legacyEmissionsAt(stack.legacyEmissions);
  const locked = ctx.lockedPoolAt(stack.lockedRewardsPool);
  // A browser session knows its originating buyer before a signing wallet connects.
  // Read that buyer only; do not query positions or rewards for the zero address.
  const walletConnected = !sameAddress(ctx.address, ZeroAddress);
  const agentId = walletConnected ? await agentIdOf(ctx) : 0;

  // Indexed reward failures stay unavailable; the no-indexer path retains live previews.
  let historySource: RewardsView['historySource'];
  let stakerSource: RewardsView['staker']['source'];
  let stakerPositions: Array<{ id: number; agentId: number; amount: bigint; closedAtEpoch: number }> = [];
  let stakerAvailable = true;
  if (walletConnected && pools && poolRewards) {
    if (ctx.indexer()?.rewardPositions) {
      try {
        const snapshot = await indexedWalletRewards(ctx, stack.currentEpoch);
        historySource = 'indexer';
        stakerSource = { indexedBlock: snapshot.source.indexedBlock, indexedAt: snapshot.source.indexedAt };
        stakerPositions = snapshot.positions.map(row => ({ id: row.id, agentId: row.agentId, amount: BigInt(row.rewards.pending!), closedAtEpoch: row.closedAtEpoch }));
      } catch (error) {
        if (error instanceof IndexerSyncingError) throw error;
        stakerAvailable = false;
        stakerSource = { error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      const closed = await closedPositionIds(ctx);
      historySource = closed.source;
      stakerPositions = await previewPoolRewards(pools, poolRewards, ctx.address, undefined, { includeIds: closed.ids });
    }
  }
  const stakerTotal = stakerPositions.reduce((sum, position) => sum + position.amount, 0n);

  const sellerEpochs: EpochAmount[] = [];
  let sellerTotal = 0n;
  const buyerEpochs: EpochAmount[] = [];
  let buyerTotal = 0n;
  if (stack.phase === 'active' && usageAccounting && epochs.recognized.length > 0) {
    const pending = walletConnected
      ? await pendingEpochRewards(epochs.recognized, async (batch) => (await usageAccounting.pendingEmissions(ctx.address, batch)).seller)
      : 0n;
    sellerTotal = pending;
    // Only epochs where this wallet actually earned points are checked per
    // epoch; the indexer knows which, so the loop stays bounded.
    const candidates = await usageEpochsOf(ctx, epochs.recognized, stack.currentEpoch);
    if (usageRewards && candidates.length <= MAX_EPOCH_BREAKDOWN) {
      const breakdown = await Promise.all(candidates.map(async (epoch) => {
        const [sellerClaimed, buyerClaimed] = await Promise.all([
          agentId ? usageRewards.agentEpochClaimed(agentId, epoch) : Promise.resolve(false),
          usageRewards.buyerEpochClaimed(ctx.buyerAddress, epoch),
        ]);
        const [sellerAmount, buyerAmount] = await Promise.all([
          agentId && !sellerClaimed ? usageRewards.pendingAgentReward(agentId, epoch) : Promise.resolve(0n),
          buyerClaimed ? Promise.resolve(0n) : usageRewards.pendingBuyerReward(ctx.buyerAddress, epoch),
        ]);
        return { epoch, sellerAmount, sellerClaimed, buyerAmount, buyerClaimed };
      }));
      for (const row of breakdown) {
        if (row.sellerAmount > 0n || row.sellerClaimed) sellerEpochs.push({ epoch: row.epoch, amount: row.sellerAmount.toString(), claimed: row.sellerClaimed });
        if (row.buyerAmount > 0n || row.buyerClaimed) buyerEpochs.push({ epoch: row.epoch, amount: row.buyerAmount.toString(), claimed: row.buyerClaimed });
        buyerTotal += row.buyerAmount;
      }
    } else if (usageRewards) {
      for (const epoch of candidates) {
        if (await usageRewards.buyerEpochClaimed(ctx.buyerAddress, epoch)) continue;
        buyerTotal += await usageRewards.pendingBuyerReward(ctx.buyerAddress, epoch);
      }
    }
  }
  const operator = await buyerOperator(ctx);
  const walletAddress = ctx.signer ? await ctx.signer.getAddress() : ctx.address;

  let legacySeller = 0n;
  let legacyBuyer = 0n;
  if (legacy && epochs.legacy.length > 0) {
    const pending = await pendingEpochRewards(epochs.legacy, async (batch) => {
      if (!walletConnected) {
        legacyBuyer += (await legacy.pendingEmissions(ctx.buyerAddress, batch)).buyer;
        return 0n;
      }
      const result = await legacy.pendingEmissions(ctx.address, batch);
      legacyBuyer += ctx.buyerAddress.toLowerCase() === ctx.address.toLowerCase() ? result.buyer : (await legacy.pendingEmissions(ctx.buyerAddress, batch)).buyer;
      return result.seller;
    });
    legacySeller = pending;
  }

  const lockedInfo = walletConnected && locked ? await locked.claimable(ctx.address) : { locked: 0n, claimable: 0n, policy: ZeroAddress };
  const sellerPayout = legacySeller > 0n ? await legacySellerPayout(ctx, stack.legacyEmissions) : undefined;

  const total = stakerTotal + sellerTotal + buyerTotal + legacySeller + legacyBuyer + lockedInfo.claimable;
  return toJson({
    scope: walletConnected ? 'all' : 'buyer',
    currentEpoch: stack.currentEpoch,
    historySource,
    firstRewardedEpoch: stack.effectiveEpoch,
    staker: {
      total: stakerAvailable ? stakerTotal.toString() : null,
      ...(stakerSource ? { source: stakerSource } : {}),
      positions: stakerPositions.filter((position) => position.amount > 0n).map((position) => ({ id: position.id, agentId: position.agentId, amount: position.amount.toString(), closed: position.closedAtEpoch !== 0 })),
    },
    sellerUsage: { total: sellerTotal.toString(), agentId, epochs: sellerEpochs, claimable: stack.phase === 'active' && agentId !== 0 },
    buyerUsage: {
      total: buyerTotal.toString(), epochs: buyerEpochs, operator,
      claimable: stack.phase === 'active' && sameAddress(operator, walletAddress), recipient: operator,
    },
    legacy: { seller: legacySeller.toString(), buyer: legacyBuyer.toString(), contract: stack.legacyEmissions, buyerClaimable: sameAddress(operator, walletAddress), sellerPayout },
    locked: {
      locked: lockedInfo.locked.toString(), claimable: lockedInfo.claimable.toString(),
      policy: sameAddress(lockedInfo.policy, ZeroAddress) ? null : lockedInfo.policy, pool: stack.lockedRewardsPool,
    },
    total: stakerAvailable ? total.toString() : null,
  });
}

async function rewardCandidateIds(ctx: AntsContext): Promise<number[]> {
  if (ctx.indexer()?.rewardPositions) {
    try {
      const snapshot = await indexedWalletRewards(ctx, (await ctx.stack()).currentEpoch, true);
      const local = [...ctx.localPositionIds].filter(([, owner]) => owner.toLowerCase() === ctx.address.toLowerCase()).map(([id]) => id);
      return [...new Set([...snapshot.positions.map(row => row.id), ...local])];
    } catch {}
  }
  return (await closedPositionIds(ctx)).ids;
}

/** Bring every pool's reward index up to the epoch the given positions need before claiming or restaking. */
async function preparePoolIndexes(
  pools: SellerPoolsClient,
  poolRewards: SellerPoolsRewardsClient,
  signer: AbstractSigner,
  targets: Array<{ agentId: number; closedAtEpoch: number }>,
  report: StepReporter,
): Promise<void> {
  const currentEpoch = await pools.currentEpoch();
  for (const agentId of new Set(targets.map((target) => target.agentId))) {
    const targetEpoch = targets.filter((target) => target.agentId === agentId)
      .reduce((latest, target) => Math.max(latest, Math.min(currentEpoch, target.closedAtEpoch || currentEpoch)), 0);
    let cursor = await poolRewards.poolRewardIndexNextEpoch(agentId) || await poolRewards.initialIndexEpoch();
    while (cursor < targetEpoch) {
      await report(`Indexing pool ${agentId} rewards (epochs ${cursor}…${Math.min(targetEpoch, cursor + 16) - 1})`);
      const hash = await poolRewards.indexPoolRewards(signer, agentId, Math.min(16, targetEpoch - cursor));
      await report('Index transaction confirmed', hash);
      const next = await poolRewards.poolRewardIndexNextEpoch(agentId);
      if (next <= cursor) throw new Error('Reward indexing made no progress; retry later.');
      cursor = next;
    }
  }
}

export interface ClaimResult { claimed: string; transactions: string[]; buckets: RewardBucket[]; }

export async function claim(ctx: AntsContext, request: ClaimRequest, report: StepReporter = silentReporter): Promise<ClaimResult> {
  const signer = ctx.requireSigner();
  const walletAddress = ctx.signer ? await ctx.signer.getAddress() : ctx.address;
  const stack = await ctx.stack();
  const epochs = await ctx.claimableEpochs();
  const recipient = request.recipient ?? (request.scope === 'buyer' ? walletAddress : ctx.address);
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error('Recipient must be an address.');
  if (request.scope !== undefined && request.scope !== 'buyer' && request.scope !== 'wallet') throw new Error('Unknown reward scope.');
  if (request.scope === 'buyer' && !sameAddress(await buyerOperator(ctx), walletAddress)) {
    throw new Error(`Connect the authorized wallet for buyer ${ctx.buyerAddress}.`);
  }
  const requested = request.buckets.length > 0 ? request.buckets : (['staker', 'seller', 'buyer', 'legacy', 'locked'] as RewardBucket[]);
  const buckets = request.scope === 'buyer' ? requested.filter(bucket => bucket === 'buyer' || bucket === 'legacy') : request.scope === 'wallet' ? requested.filter(bucket => bucket !== 'buyer') : requested;
  if (request.expectedLegacySellerRecipient !== undefined && buckets.includes('legacy') && request.scope !== 'buyer') {
    const payout = await legacySellerPayout(ctx, stack.legacyEmissions);
    if (payout.destination === 'unknown' || !sameAddress(payout.recipient, request.expectedLegacySellerRecipient)) {
      throw new Error('Legacy seller payout destination changed or could not be verified. Refresh rewards and review the claim again.');
    }
  }
  const token = ctx.antsToken();
  const transactions: string[] = [];
  let claimed = 0n;
  const record = async (hash: string, label: string, credit = true) => {
    transactions.push(hash);
    if (credit) claimed += await token.receivedInTransaction(hash, recipient);
    await report(label, hash);
  };

  if (buckets.includes('staker')) {
    const pools = ctx.pools();
    const poolRewards = ctx.poolRewards();
    if (pools && poolRewards) {
      const includeIds = await rewardCandidateIds(ctx);
      const pending = (await previewPoolRewards(pools, poolRewards, ctx.address, undefined, { includeIds })).filter((position) => position.amount > 0n);
      if (pending.length > 0) {
        await preparePoolIndexes(pools, poolRewards, signer, pending, report);
        const ids: number[] = [];
        for (const position of pending) if (await poolRewards.pendingIndexedStakerReward(position.id) > 0n) ids.push(position.id);
        for (let offset = 0; offset < ids.length; offset += 32) {
          const batch = ids.slice(offset, offset + 32);
          await report(`Claiming staker rewards for position(s) ${batch.join(', ')}`);
          await record(await poolRewards.claimStakerRewardsBatch(signer, batch, recipient), 'Staker rewards claimed');
        }
      }
    }
  }

  if (buckets.includes('seller') && stack.phase === 'active') {
    const usageAccounting = ctx.usageAccounting();
    if (usageAccounting && epochs.recognized.length > 0) {
      await claimEpochRewards(epochs.recognized,
        async (batch) => (await usageAccounting.pendingEmissions(ctx.address, batch)).seller,
        async (batch) => { await report(`Claiming seller usage rewards for epochs ${batch[0]}…${batch[batch.length - 1]}`); return usageAccounting.claimSellerEmissions(signer, batch); },
        async (hash) => record(hash, 'Seller usage rewards claimed'));
    }
  }

  if (buckets.includes('buyer') && stack.phase === 'active') {
    const usageRewards = ctx.usageRewards();
    if (usageRewards) {
      const operator = await buyerOperator(ctx);
      if (!sameAddress(operator, walletAddress)) {
        if (buckets.length === 1) throw new Error(`Connect the authorized wallet for buyer ${ctx.buyerAddress}. Current operator: ${operator ?? 'not configured'}.`);
        await report(`Buyer usage rewards are paid to the deposits operator ${operator}; claim them from that wallet.`);
      } else {
        for (const epoch of epochs.recognized) {
          if (await usageRewards.buyerEpochClaimed(ctx.buyerAddress, epoch)) continue;
          if (await usageRewards.pendingBuyerReward(ctx.buyerAddress, epoch) === 0n) continue;
          await report(`Claiming buyer usage reward for epoch ${epoch}`);
          await record(await usageRewards.claimBuyerReward(signer, ctx.buyerAddress, epoch), 'Buyer usage reward claimed');
        }
      }
    }
  }

  if (buckets.includes('legacy')) {
    const legacy = ctx.legacyEmissionsAt(stack.legacyEmissions);
    if (legacy && epochs.legacy.length > 0) {
      if (request.scope !== 'buyer') await claimEpochRewards(epochs.legacy,
        async (batch) => (await legacy.pendingEmissions(ctx.address, batch)).seller,
        async (batch) => { await report(`Claiming legacy seller emissions for epochs ${batch[0]}…${batch[batch.length - 1]}`); return legacy.claimSellerEmissions(signer, batch); },
        async (hash) => record(hash, 'Legacy seller emissions claimed'));
      if (request.scope !== 'wallet' && sameAddress(await buyerOperator(ctx), walletAddress)) await claimEpochRewards(epochs.legacy,
        async (batch) => (await legacy.pendingEmissions(ctx.buyerAddress, batch)).buyer,
        async (batch) => { await report(`Claiming legacy buyer emissions for epochs ${batch[0]}…${batch[batch.length - 1]}`); return legacy.claimBuyerEmissions(signer, ctx.buyerAddress, batch); },
        async (hash) => record(hash, 'Legacy buyer emissions claimed'));
    }
  }

  if (buckets.includes('locked')) {
    const locked = ctx.lockedPoolAt(stack.lockedRewardsPool);
    if (locked) {
      const info = await locked.claimable(ctx.address);
      if (info.claimable > 0n) {
        await report(`Releasing ${formatAnts(info.claimable)} ANTS from the locked legacy rewards pool`);
        await record(await locked.claim(signer, recipient), 'Locked rewards released');
      }
    }
  }

  ctx.invalidate();
  return { claimed: claimed.toString(), transactions, buckets };
}

export interface RestakeResult { transactions: string[]; positionIds: number[]; epochs: number; }

export async function restake(ctx: AntsContext, request: RestakeRequest, report: StepReporter = silentReporter): Promise<RestakeResult> {
  const signer = ctx.requireSigner();
  const pools = ctx.requirePools();
  const poolRewards = ctx.requirePoolRewards();
  const config = await pools.poolConfig();
  const epochs = assertEpochs(request.epochs, config.minStakeEpochs, config.maxStakeEpochs);
  const requested = request.positionIds && request.positionIds.length > 0 ? assertPositiveIds(request.positionIds) : null;
  const includeIds = requested ?? await rewardCandidateIds(ctx);
  const pending = (await previewPoolRewards(pools, poolRewards, ctx.address, undefined, { includeIds }))
    .filter((position) => position.amount > 0n && (!requested || requested.includes(position.id)));
  if (pending.length === 0) throw new Error('No staker rewards to restake.');
  await preparePoolIndexes(pools, poolRewards, signer, pending, report);
  const ids: number[] = [];
  for (const position of pending) if (await poolRewards.pendingIndexedStakerReward(position.id) > 0n) ids.push(position.id);
  if (ids.length === 0) throw new Error('Rewards are not indexed yet; retry after the next epoch.');
  const transactions: string[] = [];
  for (let offset = 0; offset < ids.length; offset += 32) {
    const batch = ids.slice(offset, offset + 32);
    await report(`Restaking rewards from position(s) ${batch.join(', ')} for ${epochs} epoch(s)`);
    const hash = await poolRewards.restakeStakerRewardsBatch(signer, batch, epochs);
    transactions.push(hash);
    await report('Restake confirmed', hash);
  }
  ctx.invalidate();
  return { transactions, positionIds: ids, epochs };
}

export interface StakeUsageResult { transactions: string[]; epochsStaked: number[]; }

export async function stakeUsageRewards(ctx: AntsContext, request: StakeUsageRequest, report: StepReporter = silentReporter): Promise<StakeUsageResult> {
  const signer = ctx.requireSigner();
  const stack = await ctx.stack();
  if (stack.phase !== 'active') throw new Error('Usage rewards can be staked once recognized usage is active.');
  const pools = ctx.requirePools();
  const usageRewards = ctx.usageRewards();
  if (!usageRewards) throw new Error('Usage rewards contract is not configured.');
  const config = await pools.poolConfig();
  const epochs = assertEpochs(request.epochs, config.minStakeEpochs, config.maxStakeEpochs);
  const claimable = await ctx.claimableEpochs();
  const transactions: string[] = [];
  const epochsStaked: number[] = [];
  if (request.side === 'seller') {
    const agentId = await agentIdOf(ctx);
    if (!agentId) throw new Error('This wallet has no seller agent.');
    for (const epoch of claimable.recognized) {
      if (await usageRewards.agentEpochClaimed(agentId, epoch)) continue;
      if (await usageRewards.pendingAgentReward(agentId, epoch) === 0n) continue;
      await report(`Staking seller usage reward for epoch ${epoch} into agent ${agentId}`);
      const hash = await usageRewards.stakeAgentReward(signer, agentId, epoch, epochs);
      transactions.push(hash);
      epochsStaked.push(epoch);
      await report('Reward staked', hash);
    }
  } else {
    const stakeAgentId = assertAgentId(request.stakeAgentId);
    const operator = await buyerOperator(ctx);
    if (!sameAddress(operator, ctx.signer ? await ctx.signer.getAddress() : ctx.address)) throw new Error(`Buyer usage rewards belong to the deposits operator ${operator}; stake them from that wallet.`);
    for (const epoch of claimable.recognized) {
      if (await usageRewards.buyerEpochClaimed(ctx.buyerAddress, epoch)) continue;
      if (await usageRewards.pendingBuyerReward(ctx.buyerAddress, epoch) === 0n) continue;
      await report(`Staking buyer usage reward for epoch ${epoch} into agent ${stakeAgentId}`);
      const hash = await usageRewards.stakeBuyerReward(signer, ctx.buyerAddress, epoch, stakeAgentId, epochs);
      transactions.push(hash);
      epochsStaked.push(epoch);
      await report('Reward staked', hash);
    }
  }
  if (transactions.length === 0) throw new Error('No unclaimed usage rewards to stake.');
  ctx.invalidate();
  return { transactions, epochsStaked };
}

export interface CompoundRequest { includeBuyer?: boolean; epochs: number; targetAgentId?: number; stakeAgentId?: number; }
export interface CompoundResult { transactions: string[]; restakedPositionIds: number[]; sellerEpochs: number[]; buyerEpochs: number[]; newPositionIds: number[]; movedPositionIds: number[]; targetAgentId: number | null; }

/**
 * Restake everything that can be restaked in one job: indexed staker rewards
 * (with the restake weight bonus, into their source pools), seller usage
 * rewards into the seller's own pool, and buyer usage rewards into
 * `stakeAgentId` (default `targetAgentId`) when this wallet is the deposits
 * operator. When `targetAgentId` is given, every new position that landed in
 * another pool is then moved there (principal, lock, and bonus preserved;
 * the move takes effect next epoch). Legacy and locked-pool rewards have no
 * stake path and are left for `claim`.
 */
export async function compound(ctx: AntsContext, request: CompoundRequest, report: StepReporter = silentReporter): Promise<CompoundResult> {
  const pools = ctx.requirePools();
  const targetAgentId = request.targetAgentId === undefined ? null : assertAgentId(request.targetAgentId);
  if (targetAgentId !== null) {
    const registry = ctx.sellerRegistry();
    const seller = registry ? await registry.agentSeller(targetAgentId) : ZeroAddress;
    if (sameAddress(seller, ZeroAddress)) throw new Error(`Agent ${targetAgentId} has no seller bound in the seller registry, so it has no stakeable pool.`);
  }
  const before = new Set(await pools.allStakerPositionIds(ctx.address));
  const result: CompoundResult = { transactions: [], restakedPositionIds: [], sellerEpochs: [], buyerEpochs: [], newPositionIds: [], movedPositionIds: [], targetAgentId };
  try {
    const restaked = await restake(ctx, { epochs: request.epochs }, report);
    result.transactions.push(...restaked.transactions);
    result.restakedPositionIds = restaked.positionIds;
  } catch (error) {
    if (!/No staker rewards|not indexed/.test((error as Error).message)) throw error;
    await report('No staker rewards to restake');
  }
  const stack = await ctx.stack();
  if (stack.phase === 'active') {
    const agentId = await agentIdOf(ctx);
    if (agentId) {
      try {
        const seller = await stakeUsageRewards(ctx, { side: 'seller', epochs: request.epochs }, report);
        result.transactions.push(...seller.transactions);
        result.sellerEpochs = seller.epochsStaked;
      } catch (error) {
        if (!/No unclaimed usage rewards/.test((error as Error).message)) throw error;
      }
    }
    const operator = await buyerOperator(ctx);
    if (request.includeBuyer !== false && sameAddress(operator, ctx.signer ? await ctx.signer.getAddress() : ctx.address)) {
      const stakeAgentId = request.stakeAgentId ?? targetAgentId ?? agentId;
      if (stakeAgentId) {
        try {
          const buyer = await stakeUsageRewards(ctx, { side: 'buyer', epochs: request.epochs, stakeAgentId }, report);
          result.transactions.push(...buyer.transactions);
          result.buyerEpochs = buyer.epochsStaked;
        } catch (error) {
          if (!/No unclaimed usage rewards/.test((error as Error).message)) throw error;
        }
      }
    }
  }
  if (result.transactions.length === 0) throw new Error('Nothing to restake.');
  const created = (await pools.allStakerPositionIds(ctx.address)).filter((id) => !before.has(id));
  result.newPositionIds = created;
  if (targetAgentId !== null && created.length > 0) {
    const positions = await pools.positionsBatch(created);
    const toMove = positions.filter((position) => position.agentId !== targetAgentId).map((position) => position.id);
    if (toMove.length > 0) {
      await report(`Moving ${toMove.length} new position(s) into agent ${targetAgentId} (effective next epoch)`);
      const hash = await pools.moveStakes(ctx.requireSigner(), toMove, targetAgentId);
      result.transactions.push(hash);
      result.movedPositionIds = toMove;
      await report('Move confirmed', hash);
    }
  }
  ctx.invalidate();
  return result;
}
