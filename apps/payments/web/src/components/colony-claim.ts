import type { ColonyState } from '../api';

/**
 * The ANTS a colony claim sends, read again after it pulled the pool's
 * emissions: this wallet's epochs (`claimAnts`), the linked Mac's own older
 * ones (`claimAntsFor`), and what the pool owes this wallet outright
 * (`claimOwedAnts`). Without a fresh read there is no telling what to claim,
 * so this throws rather than claim nothing and report success.
 */
export function colonyAntsToClaim(fresh: ColonyState | null): { antsEpochs: number[]; workerAntsEpochs: number[]; outright: boolean } {
  if (!fresh) throw new Error('Could not read what is left to claim after pulling the pool’s ANTS. Choose Claim again.');
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
