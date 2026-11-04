import { parseWorkerPayoutLink } from '@antseed/node/payments';
import { ZeroAddress } from 'ethers';
import type { WorkerPayoutLinkRequest, WorkerPoolClaimRequest, WorkerPoolsView } from '../api-types.js';
import type { AntsContext } from './context.js';
import type { StepReporter } from './steps.js';

/** Finished epochs checked for pool ANTS; older ones stay claimable through the contract. */
const ANTS_EPOCH_WINDOW = 16;

function finishedEpochs(currentEpoch: number): number[] {
  const first = Math.max(0, currentEpoch - ANTS_EPOCH_WINDOW);
  return Array.from({ length: Math.max(0, currentEpoch - first) }, (_, index) => first + index);
}

/** USDC and ANTS each configured worker pool owes the connected wallet. */
export async function workerPools(ctx: AntsContext): Promise<WorkerPoolsView> {
  const addresses = ctx.workerPoolAddresses();
  if (addresses.length === 0 || ctx.address === ZeroAddress) return { pools: [] };
  const { currentEpoch } = await ctx.stack();
  const epochs = finishedEpochs(currentEpoch);
  const pools = await Promise.all(addresses.map(async (address) => {
    const pool = ctx.workerPool(address);
    const [usdcOwed, perEpoch] = await Promise.all([
      pool.usdcBalance(ctx.address),
      Promise.all(epochs.map(async (epoch) => ({ epoch, owed: await pool.pendingAnts(ctx.address, [epoch]) }))),
    ]);
    const antsEpochs = perEpoch.filter((entry) => entry.owed > 0n).map((entry) => entry.epoch);
    const antsOwed = perEpoch.reduce((sum, entry) => sum + entry.owed, 0n);
    return { address, usdcOwed: usdcOwed.toString(), antsOwed: antsOwed.toString(), antsEpochs };
  }));
  return { pools };
}

export async function claimWorkerPool(ctx: AntsContext, request: WorkerPoolClaimRequest, report: StepReporter): Promise<{ hashes: string[] }> {
  const signer = ctx.requireSigner();
  if (!ctx.workerPoolAddresses().includes(request.pool.toLowerCase())) throw new Error('Unknown worker pool');
  const pool = ctx.workerPool(request.pool);
  const view = (await workerPools(ctx)).pools.find((entry) => entry.address === request.pool.toLowerCase());
  const hashes: string[] = [];
  if (request.usdc && view && BigInt(view.usdcOwed) > 0n) {
    const hash = await pool.claimUsdc(signer);
    hashes.push(hash);
    await report('USDC claimed from the worker pool', hash);
  }
  if (request.ants && view && view.antsEpochs.length > 0) {
    const hash = await pool.claimAnts(signer, view.antsEpochs);
    hashes.push(hash);
    await report('ANTS claimed from the worker pool', hash);
  }
  if (hashes.length === 0) throw new Error('Nothing to claim from this worker pool');
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
  const hash = await ctx.workerPool(authorization.pool).setPayout(signer, authorization);
  await report('Mac linked: its earnings now pay to this wallet', hash);
  if (!ctx.workerPoolAddresses().includes(authorization.pool.toLowerCase())) ctx.rememberWorkerPool(authorization.pool);
  return { hash, pool: authorization.pool, worker: authorization.worker };
}
