import type {
  DiscoverRow,
  VprModelCatalogEntry,
  VprRouteSelection,
  VprSelectedModel,
} from '../../core/state';
import { CODING_ONLY_SUFFIX_RE, canonicalModelKey, displayModelLabel, sameCanonicalModel } from './model-identity';
import { entryMatchText, selectRecommendedVprCatalog } from './recommended';
import { serviceModelKind } from './model-capabilities';

const VPR_MODEL_CATALOG_SEPARATOR = '\u0001';

type ModelCatalogGroup = {
  rows: DiscoverRow[];
};

export function totalRowPrice(row: DiscoverRow): number | null {
  if (serviceModelKind(row.protocol, row.capabilities) === 'image') {
    return row.minImageUsdPerImage;
  }
  if (row.inputUsdPerMillion === null || row.outputUsdPerMillion === null) return null;
  return row.inputUsdPerMillion + row.outputUsdPerMillion;
}

function minPrice(values: Array<number | null>): number | null {
  let min: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    min = min === null ? value : Math.min(min, value);
  }
  return min;
}

function maxPrice(values: Array<number | null>): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    max = max === null ? value : Math.max(max, value);
  }
  return max;
}

function preferredGroupLabel(rows: DiscoverRow[]): string {
  const labels = rows.map((row) => ({
    label: displayModelLabel(row.serviceId, row.serviceLabel),
    sellerNamed: row.serviceLabel.trim().length > 0 && row.serviceLabel.trim() !== row.serviceId.trim(),
  }));
  return labels.sort((a, b) => {
    const aConstrained = /\bcoding\s+only\b/i.test(a.label);
    const bConstrained = /\bcoding\s+only\b/i.test(b.label);
    if (aConstrained !== bConstrained) return aConstrained ? 1 : -1;
    if (a.sellerNamed !== b.sellerNamed) return a.sellerNamed ? -1 : 1;
    return a.label.length - b.label.length || a.label.localeCompare(b.label);
  })[0]?.label ?? '';
}

function projectGroupToEntry(
  group: ModelCatalogGroup,
  isPricingRowEligible: (row: DiscoverRow) => boolean,
): VprModelCatalogEntry {
  const firstRow = group.rows[0];
  const categories = Array.from(new Set(group.rows.flatMap((row) => row.categories))).sort((a, b) => a.localeCompare(b));
  const protocols = [...new Set(group.rows.map((row) => row.protocol))].sort();
  const kind = group.rows.some((row) => serviceModelKind(row.protocol, row.capabilities) === 'image')
    ? 'image'
    : 'text';
  const peerIds = new Set(group.rows.map((row) => row.peerId));
  // Entry-level prices must reflect sellers auto-routing may actually pick:
  // an untrusted seller's $0 offer must not label the model "Free" (or drive
  // "save up to") when a send would really route to a trusted paid seller.
  // When no seller passes the gate, fall back to all rows so the entry still
  // shows the market instead of no price at all.
  const eligibleRows = group.rows.filter(isPricingRowEligible);
  const pricingRows = eligibleRows.length > 0 ? eligibleRows : group.rows;
  const pricedRows = pricingRows
    .map((row) => ({ row, total: totalRowPrice(row) }))
    .filter((route): route is { row: DiscoverRow; total: number } => route.total !== null);
  const bestPricedRoute = pricedRows.reduce<{ row: DiscoverRow; total: number } | null>((best, route) => {
    if (best === null || route.total < best.total) return route;
    return best;
  }, null);
  const unrestrictedRows = group.rows.filter((row) => !CODING_ONLY_SUFFIX_RE.test(row.serviceId));
  const representativeRows = unrestrictedRows.length > 0 ? unrestrictedRows : group.rows;
  const representativePricedRows = pricedRows.filter(({ row }) => representativeRows.includes(row));
  const representative = representativePricedRows.reduce<{ row: DiscoverRow; total: number } | null>((best, route) => {
    if (best === null
      || route.total < best.total
      || (route.total === best.total && route.row.serviceId.localeCompare(best.row.serviceId) < 0)
    ) return route;
    return best;
  }, null)?.row ?? representativeRows[0];
  const label = preferredGroupLabel(group.rows);

  return {
    provider: representative.provider,
    serviceId: representative.serviceId,
    label,
    peerCount: peerIds.size,
    categories,
    kind,
    protocols,
    minInputUsdPerMillion: bestPricedRoute?.row.inputUsdPerMillion ?? null,
    maxInputUsdPerMillion: maxPrice(pricingRows.map((row) => row.inputUsdPerMillion)),
    minOutputUsdPerMillion: bestPricedRoute?.row.outputUsdPerMillion ?? null,
    maxOutputUsdPerMillion: maxPrice(pricingRows.map((row) => row.outputUsdPerMillion)),
    minCachedInputUsdPerMillion: minPrice(pricingRows.map((row) => row.cachedInputUsdPerMillion)),
    maxCachedInputUsdPerMillion: maxPrice(pricingRows.map((row) => row.cachedInputUsdPerMillion)),
    minImageUsdPerImage: minPrice(pricingRows.map((row) => row.minImageUsdPerImage)),
    maxImageUsdPerImage: maxPrice(pricingRows.map((row) => row.maxImageUsdPerImage)),
    // Filled by applyOpenRouterBaselines once a retail reference is available.
    expectedSavingsPct: null,
    // Free means the route itself charges nothing, cached tokens included —
    // judged per route so another seller's nonzero cached price can't veto a
    // genuinely free offer.
    hasEligibleFreeSeller: eligibleRows.some((row) =>
      totalRowPrice(row) === 0
      && (row.cachedInputUsdPerMillion === null || row.cachedInputUsdPerMillion <= 0)),
    bestPeerId: representative?.peerId ?? null,
  };
}

export function projectRowsToVprModelCatalog(
  rows: DiscoverRow[],
  isPricingRowEligible: (row: DiscoverRow) => boolean = () => true,
): VprModelCatalogEntry[] {
  const groups = new Map<string, ModelCatalogGroup>();
  for (const row of rows) {
    // Aggregate by canonical model identity so cosmetic serviceId/provider
    // variations of the same model collapse into one entry.
    const key = canonicalModelKey(row.serviceId)
      || `${row.provider}${VPR_MODEL_CATALOG_SEPARATOR}${row.serviceId}`;
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
    } else {
      groups.set(key, { rows: [row] });
    }
  }

  return Array.from(groups.values())
    .map((group) => projectGroupToEntry(group, isPricingRowEligible))
    .sort((a, b) => b.peerCount - a.peerCount || a.label.localeCompare(b.label));
}

/** Free models new users should land on first, best-first. Patterns (matched
 *  against serviceId + label, like the recommended lineup) so seller-specific
 *  variants ("gemma-4-31b-it", "google-gemma-4-31b-instruct") all hit their
 *  slot. A slot only applies while some trusted seller actually offers a
 *  matching model for free; within a slot the highest-trust free seller's
 *  entry wins. */
export const FREE_MODEL_PRIORITY: ReadonlyArray<RegExp> = [
  /deep-?seek.*flash/,
  /gpt[-\s]?oss[-\s]?120b/,
  /minimax[-\s]?m?[-\s]?3/,
  /minimax[-\s]?m?[-\s]?2\.7/,
  /haiku/,
  /qwen[-\s]?3[-\s]?235b/,
  /gpt[-\s]?oss[-\s]?20b/,
  /glm[-\s]?4.*flash/,
  /nemotron[-\s]?3[-\s]?(?:super|ultra)/,
  /nemotron[-\s]?120b/,
  /gemma/,
  /mistral[-\s]?large/,
];

/**
 * Stable-order free entries so the hardcoded priority lineup leads: entries
 * matching an earlier FREE_MODEL_PRIORITY slot come first; entries outside
 * every slot follow in their incoming (availability) order. Used by the
 * free-first surfaces (Home dropdown lead, Models recommended frame) so a
 * curated free model isn't buried just because few sellers serve it.
 */
export function sortFreeModelsByPriority(
  entries: VprModelCatalogEntry[],
): VprModelCatalogEntry[] {
  const slotFor = (entry: VprModelCatalogEntry): number => {
    const text = entryMatchText(entry);
    const index = FREE_MODEL_PRIORITY.findIndex((pattern) => pattern.test(text));
    return index === -1 ? FREE_MODEL_PRIORITY.length : index;
  };
  return [...entries].sort((a, b) => slotFor(a) - slotFor(b));
}

export function selectDefaultVprModel(
  catalog: VprModelCatalogEntry[],
  current: VprSelectedModel | null,
  freeRouteReputation: (entry: VprModelCatalogEntry) => number | null =
    (entry) => (entry.hasEligibleFreeSeller ? 0 : null),
): VprSelectedModel | null {
  if (current && findCatalogEntry(catalog, current.provider, current.serviceId)?.kind === 'text') return current;
  // First launch defaults to a free model — trying the AI VPN must cost nothing
  // before any balance exists. Candidates are entries with at least one
  // eligible $0 route (judged per route, so another seller's paid variant of
  // the same model can't mask a genuinely free offer). The hardcoded priority
  // lineup wins first; past it, the candidate whose free seller has the
  // highest trust score wins, so a barely-trusted seller never becomes the
  // first-run default just by catalog order.
  const textCatalog = catalog.filter((entry) => entry.kind === 'text');
  const freeCandidates = textCatalog.flatMap((entry) => {
    const reputation = freeRouteReputation(entry);
    return reputation === null ? [] : [{ entry, reputation }];
  });
  const slotCandidates = FREE_MODEL_PRIORITY
    .map((pattern) => freeCandidates.filter(({ entry }) => pattern.test(entryMatchText(entry))))
    .find((matches) => matches.length > 0)
    ?? freeCandidates;
  let best: { entry: VprModelCatalogEntry; reputation: number } | null = null;
  for (const candidate of slotCandidates) {
    if (!best || candidate.reputation > best.reputation) best = candidate;
  }
  const first = best?.entry
    ?? selectRecommendedVprCatalog(textCatalog)[0]
    ?? textCatalog[0];
  if (!first) return null;
  return {
    provider: first.provider,
    serviceId: first.serviceId,
    label: first.label,
    categories: [...first.categories],
  };
}

export function findCatalogEntry(
  catalog: VprModelCatalogEntry[],
  provider: string,
  serviceId: string,
): VprModelCatalogEntry | null {
  return catalog.find((entry) => entry.provider === provider && entry.serviceId === serviceId)
    // Entries aggregate serviceId variants — match any variant canonically so
    // selections that reference a sibling key still resolve to the entry.
    ?? catalog.find((entry) => sameCanonicalModel(entry.serviceId, serviceId))
    ?? null;
}

export function createVprRouteSelection(
  entry: VprModelCatalogEntry,
  peerId: string | null,
): VprRouteSelection {
  const normalizedPeerId = peerId?.trim() || null;
  return {
    model: {
      provider: entry.provider,
      serviceId: entry.serviceId,
      label: entry.label,
      categories: [...entry.categories],
    },
    mode: normalizedPeerId ? 'pinned-peer' : 'auto',
    peerId: normalizedPeerId,
  };
}
