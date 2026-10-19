import type { VprModelCatalogEntry } from '../../core/state';
import { lineupMatchText, selectRecommendedModels } from '@antseed/node/model-lineup';
import { favoriteModelKey } from './favorites';

export function isFreeCatalogEntry(entry: VprModelCatalogEntry): boolean {
  if (entry.kind !== 'text') return false;
  const {
    minInputUsdPerMillion: input,
    minOutputUsdPerMillion: output,
    minCachedInputUsdPerMillion: cached,
  } = entry;
  return input !== null && output !== null && input <= 0 && output <= 0
    && (cached === null || cached <= 0);
}

export function entryMatchText(entry: VprModelCatalogEntry): string {
  return lineupMatchText(entry);
}

export function catalogEntryKey(entry: VprModelCatalogEntry): string {
  return favoriteModelKey(entry.provider, entry.serviceId);
}

/** The curated "Recommended" list (see @antseed/node/model-lineup): frontier
 *  models in lineup order, then free models whose $0 offer comes from a
 *  trusted seller. Free is judged per route via hasEligibleFreeSeller, not via
 *  entry-minimum prices: another seller's nonzero cached price must not hide a
 *  model whose trusted seller genuinely offers it for free. */
export function selectRecommendedVprCatalog(catalog: VprModelCatalogEntry[]): VprModelCatalogEntry[] {
  return selectRecommendedModels(catalog, {
    keyOf: catalogEntryKey,
    hasTrustedFreeSeller: (entry) => entry.kind === 'text' && entry.hasEligibleFreeSeller,
  });
}

/** Catalog entries the user starred on their model pages, in catalog order. */
export function selectFavoriteVprCatalog(
  catalog: VprModelCatalogEntry[],
  favorites: ReadonlySet<string>,
): VprModelCatalogEntry[] {
  if (favorites.size === 0) return [];
  return catalog.filter((entry) => favorites.has(catalogEntryKey(entry)));
}
