import type { DiscoverRow } from '../../../core/state';

export type DiscoverSortKey =
  | 'recentlyUsed'
  | 'serviceAsc' | 'serviceDesc'
  | 'priceAsc' | 'priceDesc'
  | 'stakeDesc'
  | 'reputationDesc'
  | 'channelsDesc'
  | 'lastSettledDesc';

export const MAX_INPUT_PRICE_SLIDER_USD = 3;
export const INPUT_PRICE_SLIDER_STEP = 0.1;
export const MAX_OUTPUT_PRICE_SLIDER_USD = 3;
export const OUTPUT_PRICE_SLIDER_STEP = 0.1;
export const MAX_STAKE_SLIDER_ANTS = 1000;

export const MAX_REPUTATION_SCORE_SLIDER = 100;
export const REPUTATION_SCORE_SLIDER_STEP = 1;
export const DEFAULT_MIN_REPUTATION_SCORE = 0;

/**
 * Friendlier display labels for raw lowercase category tags announced by
 * sellers. The map is deliberately small — only tags whose raw form is
 * opaque to end users get a rewrite. Everything else passes through as-is.
 *
 * The underlying data (categorySet, row.categories, search matching) still
 * uses the raw tag — this is purely a render-time convenience.
 */
const CATEGORY_DISPLAY_LABELS: Record<string, string> = {
  multimodal: 'image upload',
};

export function formatCategoryLabel(category: string): string {
  const key = category.trim().toLowerCase();
  return CATEGORY_DISPLAY_LABELS[key] ?? category;
}

export type DiscoverFilterInputs = {
  search: string;
  categorySet: Set<string>;
  peerSet: Set<string>;
  maxInputPrice: number;
  maxOutputPrice: number;
  /** Minimum ANTS staked in the seller pool. */
  minStakeAnts: number;
  minReputationScore: number;
};

export function hasBeenUsed(row: DiscoverRow): boolean {
  return row.lifetimeRequests > 0
    || row.lifetimeSessions > 0
    || row.lifetimeInputTokens > 0
    || row.lifetimeOutputTokens > 0
    || row.lifetimeLastSessionAt != null;
}

export function matchesSearch(row: DiscoverRow, q: string): boolean {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (row.serviceLabel.toLowerCase().includes(needle)) return true;
  if ((row.peerDisplayName ?? '').toLowerCase().includes(needle)) return true;
  if (row.peerLabel.toLowerCase().includes(needle)) return true;
  for (const c of row.categories) {
    if (c.toLowerCase().includes(needle)) return true;
  }
  return false;
}

export function matchesMaxInputPrice(row: DiscoverRow, maxPrice: number): boolean {
  if (maxPrice >= MAX_INPUT_PRICE_SLIDER_USD) return true;
  const input = row.inputUsdPerMillion;
  if (input == null) return false;
  return input <= maxPrice;
}

export function matchesMaxOutputPrice(row: DiscoverRow, maxPrice: number): boolean {
  if (maxPrice >= MAX_OUTPUT_PRICE_SLIDER_USD) return true;
  const output = row.outputUsdPerMillion;
  if (output == null) return false;
  return output <= maxPrice;
}

export function hasValidCachedInputPrice(row: DiscoverRow): boolean {
  const cached = row.cachedInputUsdPerMillion;
  if (cached == null) return true;
  const input = row.inputUsdPerMillion;
  return input != null && cached <= input;
}

export function matchesCategoryFilter(row: DiscoverRow, set: Set<string>): boolean {
  if (set.size === 0) return true;
  return row.categories.some((c) => set.has(c.toLowerCase()));
}

export function matchesPeerFilter(row: DiscoverRow, set: Set<string>): boolean {
  if (set.size === 0) return true;
  return set.has(row.peerId);
}

export function matchesMinStake(row: DiscoverRow, minStakeAnts: number): boolean {
  if (minStakeAnts <= 0) return true;
  return row.poolStakeAnts >= minStakeAnts;
}

/**
 * Effective on-chain channel count for a peer. Prefers the live value from
 * AntseedChannels.getAgentStats; falls back to the peer-metadata count while
 * chain stats haven't loaded yet.
 */
export function rowChannelCount(row: DiscoverRow): number {
  const active = row.onChainActiveChannelCount ?? 0;
  const meta = row.onChainChannelCount ?? 0;
  return Math.max(active, meta);
}

export function rowReputationScore(row: DiscoverRow): number {
  const score = row.effectiveReputationScore ?? row.onChainReputationScore;
  return typeof score === 'number' && Number.isFinite(score)
    ? score
    : -1;
}

export function matchesMinReputationScore(row: DiscoverRow, minScore: number): boolean {
  if (minScore <= DEFAULT_MIN_REPUTATION_SCORE) return true;
  const score = rowReputationScore(row);
  return score >= minScore;
}

export function applyFilters(rows: DiscoverRow[], inputs: DiscoverFilterInputs): DiscoverRow[] {
  return rows.filter((row) =>
    matchesSearch(row, inputs.search)
    && matchesCategoryFilter(row, inputs.categorySet)
    && matchesPeerFilter(row, inputs.peerSet)
    && matchesMaxInputPrice(row, inputs.maxInputPrice)
    && matchesMaxOutputPrice(row, inputs.maxOutputPrice)
    && hasValidCachedInputPrice(row)
    && matchesMinStake(row, inputs.minStakeAnts)
    && matchesMinReputationScore(row, inputs.minReputationScore)
  );
}

export function applySort(rows: DiscoverRow[], key: DiscoverSortKey, dir: 'asc' | 'desc'): DiscoverRow[] {
  const out = rows.slice();
  const priceOf = (r: DiscoverRow): number => {
    const inp = r.inputUsdPerMillion;
    const out = r.outputUsdPerMillion;
    if (inp == null && out == null) return Number.POSITIVE_INFINITY;
    return (inp ?? 0) + (out ?? 0);
  };
  const cmp = (a: DiscoverRow, b: DiscoverRow): number => {
    switch (key) {
      case 'recentlyUsed': {
        const aHas = a.lifetimeSessions > 0 ? 1 : 0;
        const bHas = b.lifetimeSessions > 0 ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas;
        if (aHas === 1) {
          const aTs = a.lifetimeLastSessionAt ?? 0;
          const bTs = b.lifetimeLastSessionAt ?? 0;
          if (aTs !== bTs) return bTs - aTs;
        }
        return a.serviceLabel.localeCompare(b.serviceLabel);
      }
      case 'serviceAsc':
      case 'serviceDesc':
        return a.serviceLabel.localeCompare(b.serviceLabel);
      case 'priceAsc':
      case 'priceDesc':
        return priceOf(a) - priceOf(b);
      case 'stakeDesc':
        return b.poolStakeAnts - a.poolStakeAnts;
      case 'reputationDesc': {
        const diff = rowReputationScore(b) - rowReputationScore(a);
        if (diff !== 0) return diff;
        return rowChannelCount(b) - rowChannelCount(a);
      }
      case 'channelsDesc': {
        const diff = rowChannelCount(b) - rowChannelCount(a);
        if (diff !== 0) return diff;
        return priceOf(a) - priceOf(b);
      }
      case 'lastSettledDesc':
        return b.onChainLastSettledAt - a.onChainLastSettledAt;
      default:
        return 0;
    }
  };

  out.sort((a, b) => {
    const base = cmp(a, b);
    if (key === 'serviceDesc' || key === 'priceDesc') {
      return -base;
    }
    return base;
  });
  return out;
}

export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (Math.max(1, page) - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function totalPagesFor(totalResults: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalResults / pageSize));
}
