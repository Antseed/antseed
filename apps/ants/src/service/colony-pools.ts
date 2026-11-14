import { COLONY_POOL_ABI, multicallRead, parseWorkerPayoutLink } from '@antseed/node/payments';
import { Interface, ZeroAddress } from 'ethers';
import type { WorkerPayoutLinkRequest, ColonyPoolClaimRequest, ColonyPoolForgetRequest, ColonyPoolsView } from '../api-types.js';
import type { AntsContext, ResolvedStack } from './context.js';
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
const EPOCH_READS = new Interface(COLONY_POOL_ABI);
/** The emissions contract's per-epoch view of what a pull would bring the pool. */
const EMISSIONS_READS = new Interface(['function pendingEmissions(address account, uint256[] epochs) view returns (uint256 seller, uint256 buyer)']);

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
  const stack = await ctx.stack();
  const epochs = finishedEpochs(stack.currentEpoch);
  // One pool that can't be read (a bad link, an RPC error) must not hide the others.
  return {
    pools: await Promise.all(addresses.map(async (address) => {
      try {
        return await readColonyPool(ctx, address, epochs, stack);
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

/** What one colony pool owes the connected wallet over `epochs`, read against `stack`. */
async function readColonyPool(ctx: AntsContext, address: string, epochs: number[], stack: ResolvedStack): Promise<ColonyPoolsView['pools'][number]> {
  const pool = ctx.colonyPool(address);
  // Macs linked here keep their ANTS from before the link (older epochs than it moved): this
  // wallet claims those with claimAntsFor, but only while each Mac's payout is still this wallet.
  const linked = ctx.colonyPoolWorkers(address).filter((worker) => worker !== ctx.address.toLowerCase());
  const payouts = await Promise.all(linked.map((worker) => pool.payoutOf(worker)));
  const workers = linked.filter((_, index) => payouts[index]!.toLowerCase() === ctx.address.toLowerCase());
  const [usdcOwed, own, ...workerEarnings] = await Promise.all([
    pool.usdcBalance(ctx.address),
    accountAnts(ctx, address, ctx.address, epochs),
    ...workers.map((worker) => accountAnts(ctx, address, worker, epochs)),
  ]);
  // Funding depends only on the pool and epoch: one read for every account's weighted epochs.
  const weighted = [...new Set([own, ...workerEarnings].flatMap((earned) => earned.weighted))].sort((a, b) => a - b);
  const funding = await readEach(ctx, address, 'epochAnts', weighted.map((epoch) => [epoch]));
  const unfunded = new Set(weighted.filter((_, index) => funding[index] === 0n));
  const unfundedEpochs = await withUpstreamReward(ctx, stack, address, [...unfunded]);
  const pullable = new Set(unfundedEpochs);
  // A linked Mac stays in the claim while it has ANTS to claim now or after a pull of its epochs.
  const workerAnts = workers
    .map((worker, index) => ({ worker, earned: workerEarnings[index]! }))
    .filter(({ earned }) => earned.epochs.length > 0 || earned.weighted.some((epoch) => pullable.has(epoch)))
    .map(({ worker, earned }) => ({ worker, antsOwed: earned.owed.toString(), antsEpochs: earned.epochs }));
  const antsOwed = workerEarnings.reduce((sum, earned) => sum + earned.owed, own.owed);
  return {
    address, usdcOwed: usdcOwed.toString(), antsOwed: antsOwed.toString(), antsEpochs: own.epochs, unfundedEpochs,
    ...(workerAnts.length > 0 ? { workerAnts } : {}),
    forgettable: ctx.isLinkedColonyPool(address),
  };
}

/** What `account` has earned in ANTS on a pool over `epochs`: the epochs it has weight in, and what it can claim now. */
async function accountAnts(ctx: AntsContext, pool: string, account: string, epochs: number[]): Promise<{ owed: bigint; epochs: number[]; weighted: number[] }> {
  // Only an epoch the account has weight in can owe it ANTS, so the rest cost one batched read each.
  const weights = await readEach(ctx, pool, 'epochWeight', epochs.map((epoch) => [epoch, account]));
  const weighted = epochs.filter((_, index) => weights[index]! > 0n);
  const owedEach = await readEach(ctx, pool, 'pendingAnts', weighted.map((epoch) => [account, [epoch]]));
  return {
    owed: owedEach.reduce((sum, owed) => sum + owed, 0n),
    epochs: weighted.filter((_, index) => owedEach[index]! > 0n),
    weighted,
  };
}

/**
 * The unfunded epochs a pull could fund: an epoch the emissions contract shows
 * no seller reward for would only spend gas. One whose reward can't be read
 * (or is locked) is kept, so the pull can say why.
 */
async function withUpstreamReward(ctx: AntsContext, stack: ResolvedStack, pool: string, epochs: number[]): Promise<number[]> {
  if (epochs.length === 0) return epochs;
  const pending = await multicallRead(ctx.provider(), epochs.map((epoch) => ({
    target: stack.registryPointers.emissions, iface: EMISSIONS_READS, method: 'pendingEmissions', args: [pool, [epoch]],
  })));
  return epochs.filter((_, index) => pending[index]?.[0] !== 0n);
}

export async function claimColonyPool(ctx: AntsContext, request: ColonyPoolClaimRequest, report: StepReporter): Promise<{ hashes: string[] }> {
  const signer = ctx.requireSigner();
  const address = request.pool.toLowerCase();
  if (!ctx.colonyPoolAddresses().includes(address)) throw new Error('Unknown colony pool');
  const pool = ctx.colonyPool(request.pool);
  const stack = ctx.address === ZeroAddress ? undefined : await ctx.stack();
  const view = stack && await readColonyPool(ctx, address, finishedEpochs(stack.currentEpoch), stack);
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
    antsEpochs = await withNewlyFunded(ctx, address, ctx.address, antsEpochs, view.unfundedEpochs);
  }
  if (request.ants) {
    for (const epochs of batches(antsEpochs, MAX_EPOCHS_PER_CLAIM)) {
      const hash = await pool.claimAnts(signer, epochs);
      hashes.push(hash);
      await report('ANTS claimed from the colony pool', hash);
    }
    // Each linked Mac's own older ANTS: the pool pays them only to its payout, this wallet.
    for (const linked of view?.workerAnts ?? []) {
      const epochs = view!.unfundedEpochs.length > 0
        ? await withNewlyFunded(ctx, address, linked.worker, linked.antsEpochs, view!.unfundedEpochs)
        : linked.antsEpochs;
      for (const batch of batches(epochs, MAX_EPOCHS_PER_CLAIM)) {
        const hash = await pool.claimAntsFor(signer, linked.worker, batch);
        hashes.push(hash);
        await report(`ANTS a linked Mac (${linked.worker.slice(0, 10)}…) earned before its link claimed to this wallet`, hash);
      }
    }
  }
  if (hashes.length === 0) throw new Error('Nothing to claim from this colony pool');
  return { hashes };
}

/** `epochs`, plus those of `pulled` that owe `account` ANTS now their emissions were pulled. */
async function withNewlyFunded(ctx: AntsContext, pool: string, account: string, epochs: number[], pulled: number[]): Promise<number[]> {
  const owed = await readEach(ctx, pool, 'pendingAnts', pulled.map((epoch) => [account, [epoch]]));
  return [...new Set([...epochs, ...pulled.filter((_, index) => owed[index]! > 0n)])].sort((a, b) => a - b);
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
  // The link is on-chain either way; a failed save only means a restart forgets the pool (until it is
  // configured) or the Mac (whose ANTS from before the link this wallet then can't see here).
  try {
    if (!ctx.colonyPoolAddresses().includes(authorization.pool.toLowerCase())) await ctx.rememberColonyPool(authorization.pool);
    await ctx.rememberColonyPoolWorker(authorization.pool, authorization.worker);
  } catch (error) {
    await report(`Could not save the colony pool for later sessions: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { hash, pool: authorization.pool, worker: authorization.worker };
}

/** Stop showing a colony pool linked from this dashboard (e.g. one that can no longer be read). */
export async function forgetColonyPool(ctx: AntsContext, request: ColonyPoolForgetRequest): Promise<{ pool: string }> {
  if (!request?.pool || !/^0x[0-9a-fA-F]{40}$/.test(request.pool)) throw new Error('Name the colony pool to forget');
  await ctx.forgetColonyPool(request.pool);
  return { pool: request.pool.toLowerCase() };
}
