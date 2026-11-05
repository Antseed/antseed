/**
 * Antseed Points boost per seller for the model list, from Antscan's pool
 * powers (cached by `createBoostLookup`). Display only: routing never sees it.
 */
import { createBoostLookup, type BoostBySeller } from '@antseed/ants/service';

const lookups = new Map<string, () => Promise<BoostBySeller | null>>();

/** Lowercase seller address → boost; null when no explorer is configured or Antscan is unreachable. */
export function readSellerBoosts(explorerApiUrl: string | undefined): Promise<BoostBySeller | null> {
  const key = explorerApiUrl ?? '';
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = createBoostLookup(key);
    lookups.set(key, lookup);
  }
  return lookup();
}
