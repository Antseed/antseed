import { Interface, isError } from 'ethers';
import { estimateEarlyExit, positionState, projectedEarlyExitSlashBps, type SellerPoolPosition, type SellerPoolConfig } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import type { PositionView, PositionsView, StakeRequest, MoveRequest, SplitRequest, MergeRequest, ExtendRequest, MaxLockRequest, WithdrawRequest } from '../api-types.js';
import { parseAnts, formatAnts } from './format.js';
import { toJson } from './json.js';
import { IndexerError, type IndexedPosition } from './indexer.js';
import { stakeEligibility } from './stake-eligibility.js';
import { assertAgentId, assertEpochs, assertPositiveIds, silentReporter, type StepReporter } from './steps.js';
import { liveWalletPositions, validateWalletRewards } from './indexed-wallet.js';
import type { LivePositions } from './position-feed.js';
import { positionActionEpoch, positionActionProblem, type PositionAction } from '../position-actions.js';


export interface PositionDetail extends PositionView { raw: SellerPoolPosition; }

interface PositionSources {
  /** Antscan live status; when present, no status reads hit the chain. */
  live?: LivePositions;
  /**
   * Pending reward per position from Antscan. `undefined` = no reward feed configured (rewards are previewed on chain);
   * `null` = the feed exists but its snapshot was rejected (rewards are unknown, never zero).
   */
  indexedRewards?: Map<number, string> | null;
}

/** A position still earns until its close epoch passes (split, merge and move sources close next epoch). */
function isOpenAt(position: SellerPoolPosition, epoch: number): boolean {
  return !position.withdrawn && (position.closedAtEpoch === 0 || position.closedAtEpoch > epoch);
}

async function describePositions(ctx: AntsContext, positions: SellerPoolPosition[], currentEpoch: number, config: SellerPoolConfig, sources: PositionSources = {}): Promise<PositionDetail[]> {
  const { live, indexedRewards } = sources;
  const poolRewards = ctx.poolRewards();
  // Closed positions keep the reward earned up to their close epoch, so every id is previewed when no reward feed exists.
  const rewards = new Map<number, bigint>();
  if (indexedRewards === undefined && poolRewards && positions.length > 0) {
    const ids = positions.map((position) => position.id);
    const amounts = await poolRewards.previewStakerRewards(ids);
    ids.forEach((id, index) => rewards.set(id, amounts[index] ?? 0n));
  }
  const liveById = new Map(live?.positions.map(row => [row.id, row]));
  const statuses = live ? null : await ctx.requirePools().positionStatusesBatch(positions, currentEpoch);
  const pendingReward = (id: number): string | null => {
    if (indexedRewards === undefined) return (rewards.get(id) ?? 0n).toString();
    return indexedRewards?.get(id) ?? null;
  };
  const details = positions.map((position, index): PositionDetail => {
    const open = isOpenAt(position, currentEpoch);
    const liveRow = liveById.get(position.id);
    const { withdrawableEpoch, maxLocked, maxLockedNext, slashBps } = liveRow
      ? { withdrawableEpoch: liveRow.withdrawableEpoch!, maxLocked: liveRow.maxLocked, maxLockedNext: liveRow.maxLockedNext!, slashBps: null }
      : statuses![index]!;
    const changePending = liveRow?.changePending ?? currentEpoch < withdrawableEpoch;
    const projectedSlashBps = open ? projectedEarlyExitSlashBps(position, currentEpoch, config, maxLocked) : 0;
    const estimate = estimateEarlyExit(position, slashBps ?? projectedSlashBps);
    return {
      id: position.id,
      agentId: position.agentId,
      owner: position.owner,
      amount: position.amount.toString(),
      weightAmount: position.weightAmount.toString(),
      stakeStartEpoch: position.stakeStartEpoch,
      stakeEndEpoch: position.stakeEndEpoch,
      closedAtEpoch: position.closedAtEpoch,
      withdrawn: position.withdrawn,
      state: liveRow?.state ?? positionState(position, currentEpoch),
      withdrawableEpoch,
      changePending,
      maxLocked,
      maxLockedNext,
      slashBps,
      projectedSlashBps,
      slashedAmount: open ? estimate.slashedAmount.toString() : '0',
      returnedAmount: open ? estimate.returnedAmount.toString() : '0',
      pendingReward: pendingReward(position.id),
      ...(liveRow ? { power: liveRow.power, nextPower: liveRow.nextPower } : {}),
      epochsRemaining: open ? Math.max(0, position.stakeEndEpoch - Math.max(currentEpoch, position.stakeStartEpoch)) : 0,
      raw: position,
    };
  });
  return details.sort((a, b) => b.id - a.id);
}

/**
 * Ids of this wallet's positions that left the on-chain enumeration (split,
 * merge, move sources; withdrawals), as the indexer knows them. Empty without
 * an indexer; never reconstructed from log scans.
 */
export async function closedPositionIds(ctx: AntsContext): Promise<{ ids: number[]; source: PositionsView['historySource']; rows: IndexedPosition[] }> {
  const local = [...ctx.localPositionIds].filter(([, owner]) => owner.toLowerCase() === ctx.address.toLowerCase()).map(([id]) => id);
  const verified = local.length ? (await ctx.requirePools().positionsBatch(local)).filter(p => p.owner.toLowerCase() === ctx.address.toLowerCase() && (p.closedAtEpoch !== 0 || p.withdrawn)).map(p => p.id) : [];
  const fallback = { ids: verified, source: verified.length ? 'local' as const : 'chain' as const, rows: [] };
  const indexer = ctx.indexer();
  if (!indexer) return fallback;
  try {
    const rows = (await indexer.positions(ctx.address, true)).filter((row) => row.closedAtEpoch !== 0 || row.withdrawn);
    return { ids: [...new Set([...verified, ...rows.map((row) => row.id)])], source: 'indexer', rows };
  } catch (error) {
    if (error instanceof IndexerError) return fallback;
    throw error;
  }
}

export async function positions(ctx: AntsContext): Promise<PositionsView> {
  const stack = await ctx.stack();
  const pools = ctx.requirePools();
  const config = await pools.poolConfig();
  let live: LivePositions | undefined;
  let indexedRewards: Map<number, string> | null | undefined;
  let rewardSource: PositionsView['rewardSource'];
  if (ctx.indexer()) {
    const snapshot = await liveWalletPositions(ctx, stack.currentEpoch);
    live = snapshot;
    indexedRewards = null;
    try {
      validateWalletRewards(ctx, stack.currentEpoch, snapshot);
      indexedRewards = new Map(snapshot.positions.map(row => [row.id, row.rewards.pending!]));
      rewardSource = { indexedBlock: snapshot.source.indexedBlock, indexedAt: snapshot.source.indexedAt };
    } catch (error) { rewardSource = { error: error instanceof Error ? error.message : String(error) }; }
  }
  let list: SellerPoolPosition[];
  let closed: { source: PositionsView['historySource']; rows: IndexedPosition[] };
  if (live) {
    list = live.positions.map(row => ({ ...row, amount: BigInt(row.amount), weightAmount: BigInt(row.weightAmount) }));
    closed = { source: 'indexer', rows: live.positions };
  } else {
    const [openIds, history] = await Promise.all([pools.allStakerPositionIds(ctx.address), closedPositionIds(ctx)]);
    list = await pools.positionsBatch([...new Set([...openIds, ...history.ids])]);
    closed = history;
  }
  const details = await describePositions(ctx, list, stack.currentEpoch, config, { live, indexedRewards });
  const rewardsKnown = indexedRewards !== null && details.every(position => position.pendingReward !== null);
  if (indexedRewards && !rewardsKnown) rewardSource = { ...rewardSource, error: 'Antscan rewards have not indexed every position yet' };
  const closedById = new Map(closed.rows.map((row) => [row.id, row]));
  const stakeIn = (states: PositionView['state'][]) => details.filter((position) => states.includes(position.state)).reduce((sum, position) => sum + BigInt(position.amount), 0n);
  const activeStake = live ? BigInt(live.totals.activeStake) : stakeIn(['active', 'matured']);
  const pendingStake = live ? BigInt(live.totals.pendingStake) : stakeIn(['pending']);
  const pendingRewards = rewardsKnown ? details.reduce((sum, position) => sum + BigInt(position.pendingReward!), 0n) : null;
  return toJson({
    currentEpoch: stack.currentEpoch,
    config,
    positions: details.map(({ raw: _raw, ...view }) => {
      const meta = closedById.get(view.id);
      return meta && meta.closedAtEpoch === view.closedAtEpoch && meta.withdrawn === view.withdrawn
        ? { ...view, closedBy: meta.closedBy, replacementIds: meta.replacementIds } : view;
    }),
    totals: { activeStake: activeStake.toString(), pendingStake: pendingStake.toString(), pendingRewards: pendingRewards?.toString() ?? null, open: list.filter((position) => isOpenAt(position, stack.currentEpoch)).length },
    ...(rewardSource ? { rewardSource } : {}),
    historySource: closed.source,
    displaySource: live ? { source: 'indexer', indexedAt: live.liveSource.fetchedAt } : { source: 'chain' },
  });
}

async function ownedOpenPositions(ctx: AntsContext, ids: number[]): Promise<SellerPoolPosition[]> {
  const pools = ctx.requirePools();
  const list = await pools.positionsBatch(ids);
  const foreign = list.filter((position) => position.owner.toLowerCase() !== ctx.address.toLowerCase());
  if (foreign.length > 0) throw new Error(`Position(s) ${foreign.map((position) => position.id).join(', ')} are not owned by this wallet.`);
  const closed = list.filter((position) => position.withdrawn || position.closedAtEpoch !== 0);
  if (closed.length > 0) throw new Error(`Position(s) ${closed.map((position) => position.id).join(', ')} are already closed or withdrawn.`);
  return list;
}

async function requireNoPendingChange(ctx: AntsContext, list: SellerPoolPosition[]): Promise<void> {
  const pools = ctx.requirePools();
  const stack = await ctx.stack();
  const pending: number[] = [];
  for (const position of list) {
    if (stack.currentEpoch < await pools.positionWithdrawableEpoch(position.id)) pending.push(position.id);
  }
  if (pending.length > 0) throw new Error(`Position(s) ${pending.join(', ')} changed this epoch; try again after the next epoch boundary.`);
}

async function requireActionState(ctx: AntsContext, list: SellerPoolPosition[], action: PositionAction) {
  const pools = ctx.requirePools();
  const currentEpoch = await pools.currentEpoch();
  const sharedEpoch = positionActionEpoch(action, currentEpoch, list);
  const states = await Promise.all(list.map(async position => {
    const effectiveEpoch = action === 'merge' ? sharedEpoch : positionActionEpoch(action, currentEpoch, [position]);
    const segment = await pools.positionPowerSegmentAt(position.id, effectiveEpoch);
    const problem = positionActionProblem({ ...position, stakeEndEpoch: segment.normalEndEpoch, maxLocked: segment.maxLockPower > 0n }, action, effectiveEpoch);
    if (problem) throw new Error(`Position ${position.id}: ${problem}`);
    return { effectiveEpoch, normalEndEpoch: segment.normalEndEpoch };
  }));
  return states;
}

async function requireStakeableAgent(ctx: AntsContext, agentId: number): Promise<void> {
  const eligibility = await stakeEligibility(ctx, [agentId]);
  if (!eligibility.get(agentId)?.stakeable) {
    throw new Error(`Agent ${agentId} is not registered to its current owner in the pool's staking source.`);
  }
}

export async function stake(ctx: AntsContext, request: StakeRequest, report: StepReporter = silentReporter): Promise<{ hash: string; amount: string; agentId: number; epochs: number }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const agentId = assertAgentId(request.agentId);
  const amount = parseAnts(String(request.amount));
  const config = await pools.poolConfig();
  const epochs = assertEpochs(request.epochs, config.minStakeEpochs, config.maxStakeEpochs);
  await requireStakeableAgent(ctx, agentId);
  const token = ctx.antsToken();
  const [balance, canTransfer] = await Promise.all([token.balanceOf(ctx.address), token.canTransfer(ctx.address)]);
  if (!canTransfer) throw new Error('ANTS transfers are not enabled for this wallet, so tokens cannot be moved into the pool yet.');
  if (balance < amount) throw new Error(`Insufficient ANTS: balance ${formatAnts(balance)} ANTS, requested ${formatAnts(amount)} ANTS.`);
  await report(`Approving and staking ${formatAnts(amount)} ANTS into agent ${agentId} for ${epochs} epoch(s)`);
  const hash = await pools.stake(signer, agentId, amount, epochs);
  await report('Stake confirmed', hash);
  ctx.invalidate();
  return { hash, amount: amount.toString(), agentId, epochs };
}

export async function move(ctx: AntsContext, request: MoveRequest, report: StepReporter = silentReporter): Promise<{ hash: string }> {
  if ('amount' in request) throw new Error('Partial moves are not supported. Move whole positions instead.');
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const ids = assertPositiveIds(request.positionIds);
  const toAgentId = assertAgentId(request.toAgentId);
  const list = await ownedOpenPositions(ctx, ids);
  const already = list.filter((position) => position.agentId === toAgentId);
  if (already.length > 0) throw new Error(`Position(s) ${already.map((position) => position.id).join(', ')} already stake agent ${toAgentId}.`);
  await requireStakeableAgent(ctx, toAgentId);
  await requireActionState(ctx, list, 'move');
  await report(`Moving ${ids.length} position(s) to agent ${toAgentId} (effective next epoch)`);
  const hash = ids.length === 1 ? await pools.moveStake(signer, ids[0]!, toAgentId) : await pools.moveStakes(signer, ids, toAgentId);
  ids.forEach(id => ctx.localPositionIds.set(id, ctx.address));
  await report('Move confirmed', hash);
  return { hash };
}

export async function split(ctx: AntsContext, request: SplitRequest, report: StepReporter = silentReporter): Promise<{ hash: string }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const [id] = assertPositiveIds([request.positionId]);
  const splitAmount = parseAnts(String(request.amount));
  const [position] = await ownedOpenPositions(ctx, [id!]);
  if (splitAmount >= position!.amount) throw new Error(`Split amount must be below the position's ${formatAnts(position!.amount)} ANTS.`);
  const secondWeight = position!.weightAmount * splitAmount / position!.amount;
  if (secondWeight === 0n || position!.weightAmount - secondWeight === 0n) throw new Error('Split amount is too small: both parts need non-zero weight.');
  await requireActionState(ctx, [position!], 'split');
  await report(`Splitting ${formatAnts(splitAmount)} ANTS out of position ${id}`);
  const hash = await pools.splitStake(signer, id!, splitAmount);
  await report('Split confirmed', hash);
  return { hash };
}

export async function merge(ctx: AntsContext, request: MergeRequest, report: StepReporter = silentReporter): Promise<{ hash: string }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const ids = assertPositiveIds(request.positionIds);
  if (ids.length < 2) throw new Error('Merging needs at least two positions.');
  const list = await ownedOpenPositions(ctx, ids);
  const agents = new Set(list.map((position) => position.agentId));
  if (agents.size !== 1) throw new Error('All merged positions must stake the same agent pool.');
  const states = await requireActionState(ctx, list, 'merge');
  const ends = new Set(states.map(state => state.normalEndEpoch));
  if (ends.size !== 1) throw new Error('All merged positions must share the same lock end epoch (extend or disable max lock first to align them).');
  const iface = new Interface(['function mergeStakes(uint256[] positionIds) returns (uint256)']);
  try {
    await ctx.provider().call({ from: ctx.address, to: pools.contractAddress, data: iface.encodeFunctionData('mergeStakes', [ids]) });
  } catch (error) {
    const message = isError(error, 'CALL_EXCEPTION')
      ? 'The contract rejected the merge. Positions must share the same effective lock start and end; matching unlock dates alone are not sufficient.'
      : 'Merge simulation could not reach a reliable RPC result. No wallet request was submitted; try again when the RPC is available.';
    throw new Error(message, { cause: error });
  }
  await report(`Merging ${ids.length} positions in agent ${list[0]!.agentId}`);
  const hash = await pools.mergeStakes(signer, ids);
  await report('Merge confirmed', hash);
  return { hash };
}

export async function extend(ctx: AntsContext, request: ExtendRequest, report: StepReporter = silentReporter): Promise<{ hash: string }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const [id] = assertPositiveIds([request.positionId]);
  const config = await pools.poolConfig();
  const additional = assertEpochs(request.epochs, 1, Number.MAX_SAFE_INTEGER);
  const [position] = await ownedOpenPositions(ctx, [id!]);
  const [state] = await requireActionState(ctx, [position!], 'extend');
  const newEnd = Math.min(state!.normalEndEpoch + additional, state!.effectiveEpoch + config.maxStakeEpochs);
  if (newEnd <= state!.normalEndEpoch) throw new Error(`Position ${id} is already at the maximum lock.`);
  await report(`Extending position ${id} by ${newEnd - state!.normalEndEpoch} epoch(s) to epoch ${newEnd}`);
  const hash = await pools.extendLock(signer, id!, additional);
  await report('Extension confirmed', hash);
  return { hash };
}

export async function maxLock(ctx: AntsContext, request: MaxLockRequest, report: StepReporter = silentReporter): Promise<{ hash: string }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const [id] = assertPositiveIds([request.positionId]);
  const [position] = await ownedOpenPositions(ctx, [id!]);
  await requireActionState(ctx, [position!], request.enable ? 'enable-max-lock' : 'disable-max-lock');
  await report(request.enable ? `Enabling max lock on position ${id} (constant maximum power; withdrawal restarts the full countdown)` : `Disabling max lock on position ${id} (a fresh ${(await pools.poolConfig()).maxStakeEpochs}-epoch countdown starts next epoch)`);
  const hash = request.enable ? await pools.enableMaxLock(signer, id!) : await pools.disableMaxLock(signer, id!);
  await report('Max lock change confirmed', hash);
  return { hash };
}

export interface WithdrawPreview {
  positions: Array<{ id: number; amount: string; slashBps: number; slashedAmount: string; returnedAmount: string }>;
  totalSlashed: string;
  totalReturned: string;
  earlyExit: boolean;
  pendingRewards: string;
  transfersRestricted: boolean;
  simulationError: string | null;
}

export async function previewWithdraw(ctx: AntsContext, ids: number[]): Promise<WithdrawPreview> {
  const pools = ctx.requirePools();
  const list = await ownedOpenPositions(ctx, assertPositiveIds(ids));
  await requireNoPendingChange(ctx, list);
  const estimates = await Promise.all(list.map(async (position) => estimateEarlyExit(position, await pools.earlyExitSlashBps(position.id))));
  const pending = await ctx.poolRewards()?.previewStakerRewards(ids) ?? [];
  const transfersRestricted = !(await ctx.antsToken().canTransfer(ctx.address));
  let simulationError: string | null = null;
  try {
    const iface = new Interface(['function withdrawStakes(uint256[] ids)']);
    await ctx.provider().call({ from: ctx.address, to: pools.contractAddress, data: iface.encodeFunctionData('withdrawStakes', [ids]) });
  } catch (error) { simulationError = error instanceof Error ? error.message : String(error); }
  return {
    pendingRewards: pending.reduce((sum, amount) => sum + amount, 0n).toString(), transfersRestricted, simulationError,
    positions: estimates.map((estimate) => ({ id: estimate.id, amount: estimate.amount.toString(), slashBps: estimate.slashBps, slashedAmount: estimate.slashedAmount.toString(), returnedAmount: estimate.returnedAmount.toString() })),
    totalSlashed: estimates.reduce((sum, estimate) => sum + estimate.slashedAmount, 0n).toString(),
    totalReturned: estimates.reduce((sum, estimate) => sum + estimate.returnedAmount, 0n).toString(),
    earlyExit: estimates.some((estimate) => estimate.slashBps > 0),
  };
}

export async function withdraw(ctx: AntsContext, request: WithdrawRequest, report: StepReporter = silentReporter): Promise<{ hash: string; preview: WithdrawPreview }> {
  const pools = ctx.requirePools();
  const signer = ctx.requireSigner();
  const ids = assertPositiveIds(request.positionIds);
  const preview = await previewWithdraw(ctx, ids);
  if (preview.simulationError) throw new Error(`Withdrawal cannot execute: ${preview.simulationError}`);
  if (preview.earlyExit) {
    if (!request.acceptSlashing) throw new Error(`Early exit burns an estimated ${formatAnts(preview.totalSlashed)} ANTS of principal. Re-run with slashing accepted to proceed.`);
    if (request.maxSlashedAmount !== undefined && BigInt(preview.totalSlashed) > BigInt(request.maxSlashedAmount)) {
      throw new Error('The slashing estimate increased since it was reviewed. Review the new estimate before withdrawing.');
    }
  }
  await report(preview.earlyExit
    ? `Withdrawing ${ids.length} position(s), burning about ${formatAnts(preview.totalSlashed)} ANTS`
    : `Withdrawing ${ids.length} matured position(s)`);
  const hash = await pools.withdrawStakes(signer, ids);
  ids.forEach(id => ctx.localPositionIds.set(id, ctx.address));
  await report('Withdrawal confirmed', hash);
  ctx.invalidate();
  return { hash, preview };
}
