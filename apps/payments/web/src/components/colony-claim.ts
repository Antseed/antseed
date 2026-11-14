import type { ColonyState } from '../api';

/**
 * The ANTS a colony claim sends, read again after it pulled the pool's
 * emissions: this wallet's epochs (`claimAnts`), and the linked Mac's own
 * older ones (`claimAntsFor`). Without a fresh read there is no telling which
 * epochs to claim, so this throws rather than claim nothing and report success.
 */
export function colonyAntsToClaim(fresh: ColonyState | null): { antsEpochs: number[]; workerAntsEpochs: number[] } {
  if (!fresh) throw new Error('Could not read what is left to claim after pulling the pool’s ANTS. Choose Claim again.');
  // Until ANTS transfers open the pool can't send ANTS: they stay owed there, and only USDC is claimed.
  if (fresh.claim?.antsTransferable === false) return { antsEpochs: [], workerAntsEpochs: [] };
  return { antsEpochs: fresh.claim?.antsEpochs ?? [], workerAntsEpochs: fresh.claim?.workerAntsEpochs ?? [] };
}

/** Whether a claim from this state can send ANTS now. */
export function colonyAntsTransferable(state: ColonyState | null): boolean {
  return state?.claim?.antsTransferable !== false;
}
