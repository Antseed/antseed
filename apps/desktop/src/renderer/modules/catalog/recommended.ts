import type { VprModelCatalogEntry } from '../../core/state';
import { canonicalModelKey } from './model-identity';
import { favoriteModelKey } from './favorites';

/** Hand-picked frontier lineup pinned to the top of every model picker:
 *  the popular Claude and GPT models plus the open-source flagships buyers
 *  actually ask for. Notable variants get their OWN slot (gpt-5.6-sol and
 *  gpt-5.6-luna are different models to a buyer, not noise), so the list is
 *  per-model rather than per-family.
 *
 *  Each slot yields at most one catalog entry: the exact canonical model when
 *  a seller advertises it, otherwise the most popular variant matching the
 *  pattern that no earlier slot already claimed. A slot with no live sellers
 *  simply doesn't appear. Order here is display order. */
const RECOMMENDED_MODEL_LINEUP: ReadonlyArray<{ pattern: RegExp; exact: string }> = [
  { pattern: /opus[-\s]?5/, exact: canonicalModelKey('claude-opus-5') },
  { pattern: /gpt[-\s]?5\.6[-\s]?sol/, exact: canonicalModelKey('gpt-5.6-sol') },
  { pattern: /fable/, exact: canonicalModelKey('claude-fable-5') },
  { pattern: /gpt[-\s]?5\.6[-\s]?luna/, exact: canonicalModelKey('gpt-5.6-luna') },
  { pattern: /sonnet[-\s]?5/, exact: canonicalModelKey('claude-sonnet-5') },
  // Generic GPT 5.6 slot runs after the named variants so it lands on the
  // base model (or whichever variant they left unclaimed).
  { pattern: /gpt[-\s]?5\.6/, exact: canonicalModelKey('gpt-5.6') },
  { pattern: /kimi[-\s]?k?[-\s]?3/, exact: canonicalModelKey('kimi-k3') },
  { pattern: /minimax[-\s]?m?[-\s]?3/, exact: canonicalModelKey('minimax-m3') },
  { pattern: /deep-?seek/, exact: canonicalModelKey('deepseek-v4') },
  { pattern: /glm[-\s]?5\.2/, exact: canonicalModelKey('glm-5.2') },
  { pattern: /qwen[-\s]?3\.5/, exact: canonicalModelKey('qwen-3.5') },
  { pattern: /gemini[-\s]?3[\d.\s-]*pro/, exact: canonicalModelKey('gemini-3-pro') },
  { pattern: /grok[-\s]?4\.5/, exact: canonicalModelKey('grok-4.5') },
];

export function isFreeCatalogEntry(entry: VprModelCatalogEntry): boolean {
  if (entry.kind === 'image') return false;
  const {
    minInputUsdPerMillion: input,
    minOutputUsdPerMillion: output,
    minCachedInputUsdPerMillion: cached,
  } = entry;
  return input !== null && output !== null && input <= 0 && output <= 0
    && (cached === null || cached <= 0);
}

export function entryMatchText(entry: VprModelCatalogEntry): string {
  return `${entry.serviceId} ${entry.label}`.toLowerCase();
}

export function catalogEntryKey(entry: VprModelCatalogEntry): string {
  return favoriteModelKey(entry.provider, entry.serviceId);
}

/** The curated "Recommended" list: frontier models in lineup order, then free
 *  models whose $0 offer comes from a trusted seller (free rides along — it
 *  costs nothing to try — but Recommended is an endorsement, so a model whose
 *  only free sellers fail the routing trust gate stays out of it). */
export function selectRecommendedVprCatalog(catalog: VprModelCatalogEntry[]): VprModelCatalogEntry[] {
  const picked: VprModelCatalogEntry[] = [];
  const pickedKeys = new Set<string>();
  const pick = (entry: VprModelCatalogEntry): void => {
    const key = catalogEntryKey(entry);
    if (pickedKeys.has(key)) return;
    pickedKeys.add(key);
    picked.push(entry);
  };

  // The catalog is popularity-sorted, so the first unclaimed match is the
  // most-sold variant still available to this slot. Skipping already-picked
  // entries keeps a broad slot (gpt-5.6) from being starved by an earlier
  // narrow one (gpt-5.6-sol) that already took its most popular match.
  for (const slot of RECOMMENDED_MODEL_LINEUP) {
    const matches = catalog.filter((entry) => slot.pattern.test(entryMatchText(entry)));
    if (matches.length === 0) continue;
    const winner = matches.find((entry) => canonicalModelKey(entry.serviceId) === slot.exact)
      ?? matches.find((entry) => !pickedKeys.has(catalogEntryKey(entry)));
    if (winner) pick(winner);
  }
  for (const entry of catalog) {
    // Judged per route via hasEligibleFreeSeller, not via entry-minimum
    // prices: another seller's nonzero cached price must not hide a model
    // whose trusted seller genuinely offers it for free.
    if (entry.kind !== 'image' && entry.hasEligibleFreeSeller) pick(entry);
  }
  return picked;
}

/** Catalog entries the user starred on their model pages, in catalog order. */
export function selectFavoriteVprCatalog(
  catalog: VprModelCatalogEntry[],
  favorites: ReadonlySet<string>,
): VprModelCatalogEntry[] {
  if (favorites.size === 0) return [];
  return catalog.filter((entry) => favorites.has(catalogEntryKey(entry)));
}
