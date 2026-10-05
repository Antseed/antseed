import type { VprModelCatalogEntry } from '../../core/state';
import { canonicalModelKey } from './model-identity.js';

/**
 * Renderer-side cache + application of OpenRouter reference prices.
 *
 * The main process fetches the OpenRouter model catalog (see
 * `main/billing/openrouter-catalog.ts`); this module caches the resulting map in the
 * renderer and stamps matching `baseline*` prices onto AI VPN catalog entries so
 * the Home "Popular" list can strike through a retail baseline. Everything
 * degrades gracefully: no match / no cache → entries pass through unchanged.
 */

export type OpenRouterReferencePrice = {
  input: number | null;
  output: number | null;
  cachedInput?: number | null;
};
export type OpenRouterReferenceMap = Record<string, OpenRouterReferencePrice>;

let cachedMap: OpenRouterReferenceMap | null = null;
let inflight: Promise<OpenRouterReferenceMap | null> | null = null;

export function getCachedOpenRouterPrices(): OpenRouterReferenceMap | null {
  return cachedMap;
}

function canonicalReferenceKey(value: string): string {
  const legacyClaudeKey = value.replace(/^claude(?=(?:opus|sonnet|haiku|fable)\d)/, 'claude-');
  return canonicalModelKey(legacyClaudeKey);
}

function retailSavingsPct(
  entry: VprModelCatalogEntry,
  baselineInput: number | null,
  baselineOutput: number | null,
): number | null {
  if (entry.kind === 'image') return null;
  const prices = [
    [entry.minInputUsdPerMillion, baselineInput],
    [entry.minOutputUsdPerMillion, baselineOutput],
  ].filter((pair): pair is [number, number] => pair[0] !== null && pair[1] !== null);
  if (prices.length === 0) return null;
  const price = prices.reduce((total, pair) => total + pair[0], 0);
  const baseline = prices.reduce((total, pair) => total + pair[1], 0);
  if (baseline <= price || baseline <= 0) return null;
  return Math.round((1 - price / baseline) * 100);
}

/**
 * Warm the reference-price cache from the main process. Concurrent callers
 * share one request; resolves to the map (or `null` if unavailable).
 */
export async function ensureOpenRouterPrices(): Promise<OpenRouterReferenceMap | null> {
  if (cachedMap) return cachedMap;
  if (inflight) return inflight;
  const bridge = window.antseedDesktop;
  if (!bridge?.getOpenRouterReferencePrices) return null;
  inflight = bridge
    .getOpenRouterReferencePrices()
    .then((map) => {
      const result: OpenRouterReferenceMap = map ?? {};
      // Only cache a non-empty map — an empty result means the main process
      // couldn't fetch prices, and caching it would make the failure terminal.
      // Leaving cachedMap unset lets later calls re-request.
      if (Object.keys(result).length > 0) cachedMap = result;
      return cachedMap ?? result;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Return a copy of `catalog` with `baselineInput/OutputUsdPerMillion` populated
 * from the reference map where the model label matches. Only stamps a baseline
 * when it is strictly higher than the live min price (so we never show a
 * "discount" that isn't one).
 */
export function applyOpenRouterBaselines(
  catalog: VprModelCatalogEntry[],
  map: OpenRouterReferenceMap | null,
): VprModelCatalogEntry[] {
  if (!map || Object.keys(map).length === 0) return catalog;
  const canonicalMap = new Map<string, OpenRouterReferencePrice>();
  for (const [key, price] of Object.entries(map)) {
    const canonicalKey = canonicalReferenceKey(key);
    if (canonicalKey && !canonicalMap.has(canonicalKey)) canonicalMap.set(canonicalKey, price);
  }
  return catalog.map((entry) => {
    const ref = canonicalMap.get(canonicalReferenceKey(entry.serviceId))
      ?? canonicalMap.get(canonicalReferenceKey(entry.label));
    if (!ref) return entry;

    const baselineInput =
      ref.input !== null && (entry.minInputUsdPerMillion === null || ref.input > entry.minInputUsdPerMillion)
        ? ref.input
        : null;
    const baselineOutput =
      ref.output !== null && (entry.minOutputUsdPerMillion === null || ref.output > entry.minOutputUsdPerMillion)
        ? ref.output
        : null;

    if (baselineInput === null && baselineOutput === null) return entry;
    return {
      ...entry,
      baselineInputUsdPerMillion: baselineInput,
      baselineOutputUsdPerMillion: baselineOutput,
      expectedSavingsPct: retailSavingsPct(entry, baselineInput, baselineOutput),
    };
  });
}
