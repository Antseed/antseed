import type { Address, Hex } from 'viem';
import type { ColonyState } from '../api';

/** AntseedColonyPool.MAX_EPOCHS_PER_CLAIM. */
const MAX_EPOCHS_PER_CLAIM = 32;

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Whether `state` is what the pool holds now, not the Mac app's last read from before a read failed. */
function isFresh(state: ColonyState | null): state is ColonyState {
  return state !== null && state.claimFresh !== false;
}

/**
 * The ANTS a colony claim sends, read again after it pulled the pool's
 * emissions: this wallet's epochs (`claimAnts`), the linked Mac's own older
 * ones (`claimAntsFor`), and what the pool owes this wallet outright
 * (`claimOwedAnts`). Without a fresh read (none, or the Mac app's last one
 * because its read of the pool failed) there is no telling what to claim, so
 * this throws rather than claim nothing and report success.
 */
export function colonyAntsToClaim(fresh: ColonyState | null): { antsEpochs: number[]; workerAntsEpochs: number[]; outright: boolean } {
  if (!isFresh(fresh)) throw new Error('Could not read what is left to claim after pulling the pool’s ANTS. Choose Claim again.');
  // Until ANTS transfers open the pool can't send ANTS: they stay owed there, and only USDC is claimed.
  if (fresh.claim?.antsTransferable === false) return { antsEpochs: [], workerAntsEpochs: [], outright: false };
  return {
    antsEpochs: fresh.claim?.antsEpochs ?? [],
    workerAntsEpochs: fresh.claim?.workerAntsEpochs ?? [],
    outright: BigInt(fresh.claim?.outrightAnts ?? '0') > 0n,
  };
}

/** Whether a claim from this state can send ANTS now. */
export function colonyAntsTransferable(state: ColonyState | null): boolean {
  return state?.claim?.antsTransferable !== false;
}

/**
 * What the claim button offers from this state: the USDC, the ANTS the pool
 * can pay now (epoch shares and what it owes outright), and the epochs to pull
 * first. Until ANTS transfers open only the USDC counts.
 */
export function colonyClaimable(state: ColonyState | null): { usdc: bigint; ants: bigint; antsOpen: boolean; unpulled: number[]; nothing: boolean } {
  const usdc = BigInt(state?.claim?.usdc ?? '0');
  const ants = BigInt(state?.claim?.ants ?? '0');
  const antsOpen = colonyAntsTransferable(state);
  const unpulled = antsOpen ? state?.claim?.unpulledEpochs ?? [] : [];
  return { usdc, ants, antsOpen, unpulled, nothing: usdc === 0n && (!antsOpen || ants === 0n) && unpulled.length === 0 };
}

/** A pool transaction a claim sends. */
export type ColonyClaimCall =
  | { functionName: 'claimUsdc' | 'claimOwedAnts'; args?: undefined }
  | { functionName: 'claimAnts' | 'claimEpochEmissions'; args: readonly [readonly bigint[]] }
  | { functionName: 'claimAntsFor'; args: readonly [Address, readonly bigint[]] };

/**
 * Claims what the pool owes the payout wallet, one transaction per step: its
 * USDC, then ANTS for every finished epoch and those it is owed outright,
 * pulling the pool's emissions first for epochs it hasn't pulled yet (as the
 * ANTS dashboard's claim does). Returns the last transaction sent. The ANTS
 * steps are chosen only from a fresh read of the pool: when there is none,
 * this throws with whatever it already sent left as sent, and a retry reads
 * again.
 */
export async function claimColonyRewards(
  colony: ColonyState,
  { send, reload, onStep }: {
    send: (pool: string, call: ColonyClaimCall) => Promise<Hex>;
    reload: () => Promise<ColonyState | null>;
    onStep: (step: string) => void;
  },
): Promise<Hex> {
  let state: ColonyState | null = colony;
  if (!isFresh(state)) state = await reload();
  if (!isFresh(state) || !state.pool) throw new Error('Could not read what this Mac has to claim. Choose Claim again.');
  const pool = state.pool;
  const { usdc, unpulled } = colonyClaimable(state);
  let last: Hex | null = null;
  if (usdc > 0n) {
    onStep('Claiming USDC…');
    last = await send(pool, { functionName: 'claimUsdc' });
  }
  // The pool holds no ANTS for an epoch until its emissions are pulled; a pull that fails
  // (e.g. the pool's reward is still locked) leaves those epochs for later.
  for (const epochs of batches(unpulled, MAX_EPOCHS_PER_CLAIM)) {
    onStep('Pulling the pool’s ANTS for finished epochs…');
    try { last = await send(pool, { functionName: 'claimEpochEmissions', args: [epochs.map(BigInt)] }); } catch { /* claimed later */ }
  }
  const { antsEpochs, workerAntsEpochs, outright } = colonyAntsToClaim(unpulled.length > 0 ? await reload() : state);
  for (const epochs of batches(antsEpochs, MAX_EPOCHS_PER_CLAIM)) {
    onStep('Claiming ANTS…');
    last = await send(pool, { functionName: 'claimAnts', args: [epochs.map(BigInt)] });
  }
  // ANTS from before the link stay with the Mac's key; the pool sends them to this wallet.
  for (const epochs of batches(workerAntsEpochs, MAX_EPOCHS_PER_CLAIM)) {
    onStep('Claiming this Mac’s earlier ANTS…');
    last = await send(pool, { functionName: 'claimAntsFor', args: [state.worker as Address, epochs.map(BigInt)] });
  }
  // Not by epoch: the operator fee, or an epoch nobody earned in, which a pull above may just have credited.
  if (outright) {
    onStep('Claiming the ANTS the pool owes this wallet…');
    last = await send(pool, { functionName: 'claimOwedAnts' });
  }
  if (!last) throw new Error('Nothing to claim yet.');
  return last;
}
