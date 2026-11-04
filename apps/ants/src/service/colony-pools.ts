import { parseWorkerPayoutLink } from '@antseed/node/payments';
import { ZeroAddress } from 'ethers';
import type { WorkerPayoutLinkRequest, ColonyPoolClaimRequest, ColonyPoolsView } from '../api-types.js';
import type { AntsContext } from './context.js';
import type { StepReporter } from './steps.js';

/** AntseedColonyPool.MAX_EPOCHS_PER_CLAIM: epochs per claimAnts / claimEpochEmissions call. */
const MAX_EPOCHS_PER_CLAIM = 32;

/** Every finished epoch: pool ANTS never expire, so none is left out (epochs are weekly). */
function finishedEpochs(currentEpoch: number): number[] {
  return Array.from({ length: Math.max(0, currentEpoch) }, (_, index) => index);
}

function batches<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

/** USDC and ANTS each configured colony pool owes the connected wallet. */
export async function colonyPools(ctx: AntsContext): Promise<ColonyPoolsView> {
  const addresses = ctx.colonyPoolAddresses();
  if (addresses.length === 0 || ctx.address === ZeroAddress) return { pools: [] };
  const { currentEpoch } = await ctx.stack();
  const epochs = finishedEpochs(currentEpoch);
  return { pools: await Promise.all(addresses.map((address) => readColonyPool(ctx, address, epochs))) };
}

/** What one colony pool owes the connected wallet over `epochs`. */
async function readColonyPool(ctx: AntsContext, address: string, epochs: number[]): Promise<ColonyPoolsView['pools'][number]> {
  const pool = ctx.colonyPool(address);
  // Only an epoch the wallet has weight in can owe it ANTS, so the rest cost one read each.
  const [usdcOwed, weights] = await Promise.all([
    pool.usdcBalance(ctx.address),
    Promise.all(epochs.map(async (epoch) => ({ epoch, weight: await pool.epochWeight(epoch, ctx.address) }))),
  ]);
  const perEpoch = await Promise.all(weights.filter((entry) => entry.weight > 0n).map(async ({ epoch }) => {
    const [owed, funded] = await Promise.all([pool.pendingAnts(ctx.address, [epoch]), pool.epochAnts(epoch)]);
    return { epoch, owed, unfunded: funded === 0n };
  }));
  const antsEpochs = perEpoch.filter((entry) => entry.owed > 0n).map((entry) => entry.epoch);
  const unfundedEpochs = perEpoch.filter((entry) => entry.unfunded).map((entry) => entry.epoch);
  const antsOwed = perEpoch.reduce((sum, entry) => sum + entry.owed, 0n);
  return { address, usdcOwed: usdcOwed.toString(), antsOwed: antsOwed.toString(), antsEpochs, unfundedEpochs };
}

export async function claimColonyPool(ctx: AntsContext, request: ColonyPoolClaimRequest, report: StepReporter): Promise<{ hashes: string[] }> {
  const signer = ctx.requireSigner();
  const address = request.pool.toLowerCase();
  if (!ctx.colonyPoolAddresses().includes(address)) throw new Error('Unknown colony pool');
  const pool = ctx.colonyPool(request.pool);
  const view = ctx.address === ZeroAddress ? undefined : await readColonyPool(ctx, address, finishedEpochs((await ctx.stack()).currentEpoch));
  const hashes: string[] = [];
  if (request.usdc && view && BigInt(view.usdcOwed) > 0n) {
    const hash = await pool.claimUsdc(signer);
    hashes.push(hash);
    await report('USDC claimed from the colony pool', hash);
  }
  let antsEpochs = view?.antsEpochs ?? [];
  if (request.ants && view && view.unfundedEpochs.length > 0) {
    // The pool holds no ANTS for an epoch until someone pulls its emissions (anyone may; repeats are no-ops).
    // A pull can fail (e.g. the seller reward is still locked); the funded epochs are claimed anyway.
    for (const epochs of batches(view.unfundedEpochs, MAX_EPOCHS_PER_CLAIM)) {
      try {
        const hash = await pool.claimEpochEmissions(signer, epochs);
        hashes.push(hash);
        await report('Colony pool emissions pulled for finished epochs', hash);
      } catch (error) {
        await report(`Colony pool emissions not pulled yet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const owed = await Promise.all(view.unfundedEpochs.map(async (epoch) => ({ epoch, owed: await pool.pendingAnts(ctx.address, [epoch]) })));
    antsEpochs = [...new Set([...antsEpochs, ...owed.filter((entry) => entry.owed > 0n).map((entry) => entry.epoch)])].sort((a, b) => a - b);
  }
  if (request.ants) {
    for (const epochs of batches(antsEpochs, MAX_EPOCHS_PER_CLAIM)) {
      const hash = await pool.claimAnts(signer, epochs);
      hashes.push(hash);
      await report('ANTS claimed from the colony pool', hash);
    }
  }
  if (hashes.length === 0) throw new Error('Nothing to claim from this colony pool');
  return { hashes };
}

/**
 * Submit a Mac's signed payout authorization from the connected wallet, so the
 * pool pays that Mac's future earnings here.
 */
export async function linkWorkerPayout(ctx: AntsContext, request: WorkerPayoutLinkRequest, report: StepReporter): Promise<{ hash: string; pool: string; worker: string }> {
  const authorization = parseWorkerPayoutLink(request.code);
  if (!authorization) throw new Error('This is not a valid Mac link code');
  if (authorization.chainId !== ctx.chain.evmChainId) throw new Error(`This link is for chain ${authorization.chainId}, not ${ctx.chain.evmChainId}`);
  const signer = ctx.requireSigner();
  const wallet = await signer.getAddress();
  if (wallet.toLowerCase() !== authorization.payout.toLowerCase()) {
    throw new Error(`This link pays ${authorization.payout}; connect that wallet to submit it`);
  }
  const hash = await ctx.colonyPool(authorization.pool).setPayout(signer, authorization);
  await report('Mac linked: its earnings now pay to this wallet', hash);
  if (!ctx.colonyPoolAddresses().includes(authorization.pool.toLowerCase())) {
    // The link is on-chain either way; a failed save only means a restart forgets the pool until it is configured.
    try {
      await ctx.rememberColonyPool(authorization.pool);
    } catch (error) {
      await report(`Could not save the colony pool for later sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { hash, pool: authorization.pool, worker: authorization.worker };
}
