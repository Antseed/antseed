import type { DiscoverRow, VprRoutingPreferences } from '../../core/state';
import {
  chooseBestModelRoute,
  isModelRouteCoolingDown,
  isModelRouteEligible,
  isModelRoutePeerAllowed,
  modelRouteReputationScore,
  modelRouteTotalPrice,
  scoreModelRoute,
} from '@antseed/node/model-routing';

export type VprScoredRoute = {
  row: DiscoverRow;
  score: number;
  reasons: string[];
};

export function isRowCoolingDown(row: DiscoverRow, now: number = Date.now()): boolean {
  return isModelRouteCoolingDown(row, now);
}

export function scoreVprRoute(
  row: DiscoverRow,
  preferences: VprRoutingPreferences,
  now: number = Date.now(),
): VprScoredRoute {
  const scored = scoreModelRoute(row, preferences, now);
  return { row, score: scored.score, reasons: scored.reasons };
}

/**
 * Whether auto routing may select this peer.
 *
 * The blocklist is absolute. The allowlist is exclusive while it holds any
 * entry — an empty allowlist means "no restriction", not "nothing allowed".
 *
 * Deliberately knows nothing about cooldowns: those are a scoring penalty, not
 * a filter, so that a network where every peer is cooling down still routes.
 */
export function isPeerRoutable(peerId: string, preferences: VprRoutingPreferences): boolean {
  return isModelRoutePeerAllowed(peerId, preferences);
}

export function isRouteEligibleForAutoSelection(
  row: DiscoverRow,
  preferences: VprRoutingPreferences,
): boolean {
  return isModelRouteEligible(row, preferences);
}

/** Drop every route whose peer the allow/block lists rule out. */
export function filterRoutableVprRoutes(
  rows: DiscoverRow[],
  preferences: VprRoutingPreferences,
): DiscoverRow[] {
  return rows.filter((row) => isPeerRoutable(row.peerId, preferences));
}

/**
 * Highest seller trust score among the $0 routes auto-selection may use, or
 * null when the set has no eligible free route. Lets the default-model pick
 * rank free offers by how proven the seller is instead of treating them as
 * interchangeable.
 */
export function bestFreeVprRouteReputation(
  rows: DiscoverRow[],
  preferences: VprRoutingPreferences,
): number | null {
  let best: number | null = null;
  for (const row of rows) {
    const chargesCachedTokens = row.cachedInputUsdPerMillion !== null && row.cachedInputUsdPerMillion > 0;
    if (modelRouteTotalPrice(row) !== 0 || chargesCachedTokens || !isModelRouteEligible(row, preferences)) continue;
    const reputation = modelRouteReputationScore(row) ?? 0;
    if (best === null || reputation > best) best = reputation;
  }
  return best;
}

export function chooseBestVprRoute(
  rows: DiscoverRow[],
  preferences: VprRoutingPreferences,
  now: number = Date.now(),
  rotationKey?: string,
  advance = true,
): DiscoverRow | null {
  return chooseBestModelRoute(rows, preferences, now, rotationKey, advance);
}
