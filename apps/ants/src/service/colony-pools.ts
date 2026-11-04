import { multicallRead, parseWorkerPayoutLink } from '@antseed/node/payments';
import { Interface, ZeroAddress } from 'ethers';
import type { WorkerPayoutLinkRequest, ColonyPoolClaimRequest, ColonyPoolForgetRequest, ColonyPoolsView } from '../api-types.js';
import type { AntsContext } from './context.js';
import type { StepReporter } from './steps.js';

/** AntseedColonyPool.MAX_EPOCHS_PER_CLAIM: epochs per claimAnts / claimEpochEmissions call. */
const MAX_EPOCHS_PER_CLAIM = 32;

/** Reads of payoutOf after setPayout confirms, and the wait between them. */
const PAYOUT_READ_ATTEMPTS = 5;
const PAYOUT_READ_RETRY_MS = 1_000;

/** Every finished epoch: pool ANTS never expire, so none is left out (epochs are weekly). */
function finishedEpochs(currentEpoch: number): number[] {
  return Array.from({ length: Math.max(0, currentEpoch) }, (_, index) => index);
}

/** The per-epoch views read in bulk; claims and single reads go through ColonyPoolClient. */
const EPOCH_READS = new Interface([
  'function epochWeight(uint256 epoch, address account) view returns (uint256)',
  'function pendingAnts(address account, uint256[] epochs) view returns (uint256)',
  'function epochAnts(uint256 epoch) view returns (uint256)',
]);

/**
 * One view per argument list, batched through Multicall3 (one `eth_call` per
 * chunk instead of one per epoch). A read that fails throws: a missing value
 * must never show as zero owed.
 */
async function readEach(ctx: AntsContext, pool: string, method: string, argsList: unknown[][]): Promise<bigint[]> {
  const values = await multicallRead(ctx.provider(), argsList.map((args) => ({ target: pool, iface: EPOCH_READS, method, args })));
  return values.map((value) => {
    const amount = value?.[0];
    if (typeof amount !== 'bigint') throw new Error(`Colony pool ${pool}: ${method} unavailable.`);
    return amount;
  });
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
  // One pool that can't be read (a bad link, an RPC error) must not hide the others.
  return {
    pools: await Promise.all(addresses.map(async (address) => {
      try {
        return await readColonyPool(ctx, address, epochs);
      } catch (error) {
        return {
          address, usdcOwed: '0', antsOwed: '0', antsEpochs: [], unfundedEpochs: [],
          error: error instanceof Error ? error.message : String(error),
          forgettable: ctx.isLinkedColonyPool(address),
        };
      }
    })),
  };
}

/** What one colony pool owes the connected wallet over `epochs`. */
async function readColonyPool(ctx: AntsContext, address: string, epochs: number[]): Promise<ColonyPoolsView['pools'][number]> {
  const pool = ctx.colonyPool(address);
  // Only an epoch the wallet has weight in can owe it ANTS, so the rest cost one batched read each.
  const [usdcOwed, weights] = await Promise.all([
    pool.usdcBalance(ctx.address),
    readEach(ctx, address, 'epochWeight', epochs.map((epoch) => [epoch, ctx.address])),
  ]);
  const weighted = epochs.filter((_, index) => weights[index]! > 0n);
  const [owedEach, fundedEach] = await Promise.all([
    readEach(ctx, address, 'pendingAnts', weighted.map((epoch) => [ctx.address, [epoch]])),
    readEach(ctx, address, 'epochAnts', weighted.map((epoch) => [epoch])),
  ]);
  const perEpoch = weighted.map((epoch, index) => ({ epoch, owed: owedEach[index]!, unfunded: fundedEach[index] === 0n }));
  const antsEpochs = perEpoch.filter((entry) => entry.owed > 0n).map((entry) => entry.epoch);
  const unfundedEpochs = perEpoch.filter((entry) => entry.unfunded).map((entry) => entry.epoch);
  const antsOwed = perEpoch.reduce((sum, entry) => sum + entry.owed, 0n);
  return { address, usdcOwed: usdcOwed.toString(), antsOwed: antsOwed.toString(), antsEpochs, unfundedEpochs, forgettable: ctx.isLinkedColonyPool(address) };
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
    const owed = await readEach(ctx, address, 'pendingAnts', view.unfundedEpochs.map((epoch) => [ctx.address, [epoch]]));
    antsEpochs = [...new Set([...antsEpochs, ...view.unfundedEpochs.filter((_, index) => owed[index]! > 0n)])].sort((a, b) => a - b);
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
  // The code only proves its own format: check that it names a colony pool before sending anything,
  // since a call to an account without code succeeds and would link nothing.
  if (await ctx.provider().getCode(authorization.pool) === '0x') throw new Error(`${authorization.pool} is not a contract, so this link code is not for a colony pool`);
  const pool = ctx.colonyPool(authorization.pool);
  try {
    await pool.payoutOf(authorization.worker);
  } catch {
    throw new Error(`${authorization.pool} is not a colony pool, so this link code cannot be submitted`);
  }
  const hash = await pool.setPayout(signer, authorization);
  // Report success, and remember the pool, only once the contract records this wallet.
  // A read can lag the confirmed transaction on a load-balanced RPC, so give it a few tries.
  let recorded = await pool.payoutOf(authorization.worker);
  for (let attempt = 1; attempt < PAYOUT_READ_ATTEMPTS && recorded.toLowerCase() !== authorization.payout.toLowerCase(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, PAYOUT_READ_RETRY_MS));
    recorded = await pool.payoutOf(authorization.worker);
  }
  if (recorded.toLowerCase() !== authorization.payout.toLowerCase()) {
    throw new Error(`The colony pool did not record this wallet for the Mac (it pays ${recorded})`);
  }
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

/** Stop showing a colony pool linked from this dashboard (e.g. one that can no longer be read). */
export async function forgetColonyPool(ctx: AntsContext, request: ColonyPoolForgetRequest): Promise<{ pool: string }> {
  if (!request?.pool || !/^0x[0-9a-fA-F]{40}$/.test(request.pool)) throw new Error('Name the colony pool to forget');
  await ctx.forgetColonyPool(request.pool);
  return { pool: request.pool.toLowerCase() };
}
