/**
 * The curated "Recommended" model lineup every Antseed model picker offers:
 * the desktop's in-app dropdown, and the model lists `antseed apps connect`
 * and the buyer's Claude Desktop route write into connected apps.
 *
 * Pure functions, so the desktop, the CLI and the buyer pick the same models.
 */

import { canonicalModelKey } from './model-identity.js';
import {
  isModelRouteEligible,
  isModelRoutePeerAllowed,
  modelRouteTotalPrice,
  type ModelRoutingPreferences,
} from './routing/model-route-ranking.js';

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
export const RECOMMENDED_MODEL_LINEUP: ReadonlyArray<{ pattern: RegExp; exact: string }> = [
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

export type LineupCandidate = {
  serviceId: string;
  label: string;
};

/** Text the lineup patterns match against. */
export function lineupMatchText(entry: LineupCandidate): string {
  return `${entry.serviceId} ${entry.label}`.toLowerCase();
}

/**
 * The curated "Recommended" list: frontier models in lineup order, then free
 * models whose $0 offer comes from a trusted seller (free rides along — it
 * costs nothing to try — but Recommended is an endorsement, so a model whose
 * only free sellers fail the routing trust gate stays out of it).
 *
 * `catalog` must be popularity-sorted (most sellers first): a slot takes its
 * first unclaimed match. `keyOf` identifies an entry (two entries with the
 * same key are the same model); `hasTrustedFreeSeller` decides the free
 * ride-along.
 */
export function selectRecommendedModels<T extends LineupCandidate>(
  catalog: readonly T[],
  options: {
    hasTrustedFreeSeller: (entry: T) => boolean;
    keyOf?: (entry: T) => string;
  },
): T[] {
  const keyOf = options.keyOf ?? ((entry: T) => canonicalModelKey(entry.serviceId) || entry.serviceId);
  const picked: T[] = [];
  const pickedKeys = new Set<string>();
  const pick = (entry: T): void => {
    const key = keyOf(entry);
    if (pickedKeys.has(key)) return;
    pickedKeys.add(key);
    picked.push(entry);
  };

  // Skipping already-picked entries keeps a broad slot (gpt-5.6) from being
  // starved by an earlier narrow one (gpt-5.6-sol) that already took its most
  // popular match.
  for (const slot of RECOMMENDED_MODEL_LINEUP) {
    const matches = catalog.filter((entry) => slot.pattern.test(lineupMatchText(entry)));
    if (matches.length === 0) continue;
    const winner = matches.find((entry) => canonicalModelKey(entry.serviceId) === slot.exact)
      ?? matches.find((entry) => !pickedKeys.has(keyOf(entry)));
    if (winner) pick(winner);
  }
  for (const entry of catalog) {
    if (options.hasTrustedFreeSeller(entry)) pick(entry);
  }
  return picked;
}

/** A row of a model picker in a connected app: display label + the model the buyer routes. */
export type CuratedPickerModel = {
  label: string;
  model: string;
  /** Provider of the most common seller offer, for clients that record one with a pick. */
  provider: string;
  /** Some seller reports reasoning-effort support. */
  reasoning?: true;
  /** Starred in the desktop app. */
  favorite?: true;
};

export type CuratedPickerInputs = {
  /** Allow/block lists and the trust gate, as in `buyer.routingPreferences`. */
  preferences: ModelRoutingPreferences;
  /** Starred models (`buyer.favoriteModels`): canonical model keys, listed first after the selection. */
  favoriteModels?: readonly string[];
  /** The model selected in the AI VPN (`defaultRoutedModel`, `<peerId>@<model>` or `<model>`), listed first. */
  defaultRoutedModel?: string | null;
};

type CatalogRow = { serviceId: string; label: string; provider: string; peerCount: number; reasoning: boolean; trustedFree: boolean };

function announcesReasoning(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>)['reasoning'] === true);
}

/**
 * The id most sellers advertise for a model (no vendor prefix on a tie), so
 * apps show `claude-opus-5.5` rather than one seller's `opus-5.5` or
 * `anthropic/claude-opus-5.5`. Any variant routes: the buyer matches models
 * by canonical key.
 */
function commonServiceId(peers: readonly Record<string, unknown>[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const peer of peers) {
    const id = peer['serviceId'];
    if (typeof id === 'string' && id.trim()) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ranked = [...counts].sort(([a, countA], [b, countB]) => (
    countB - countA || Number(a.includes('/')) - Number(b.includes('/')) || a.localeCompare(b)
  ));
  return ranked[0]?.[0] ?? fallback;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The model list every Antseed model picker in a connected app offers, from
 * the buyer's `GET /v1/models` rows: the AI VPN selection, then starred
 * models, then the Recommended lineup and free models from trusted sellers.
 * Sellers outside the allow/block lists are ignored, and the catalog is
 * ranked by seller count, as in the desktop's own dropdown.
 */
export function curatedPickerModels(entries: readonly unknown[], inputs: CuratedPickerInputs): CuratedPickerModel[] {
  const { preferences } = inputs;
  const catalog: CatalogRow[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const id = entry['id'];
    if (typeof id !== 'string' || id.trim().length === 0 || entry['type'] !== 'text') continue;
    const peers = (Array.isArray(entry['peers']) ? entry['peers'] : [])
      .filter((peer): peer is Record<string, unknown> => Boolean(peer && typeof peer === 'object'))
      .filter((peer) => typeof peer['peerId'] === 'string' && isModelRoutePeerAllowed(peer['peerId'], preferences));
    if (peers.length === 0) continue;
    const name = entry['name'];
    const serviceId = commonServiceId(peers, id);
    const provider = peers.find((peer) => peer['serviceId'] === serviceId)?.['provider'] ?? peers[0]?.['provider'];
    catalog.push({
      serviceId,
      label: typeof name === 'string' && name.trim() ? name : id,
      provider: typeof provider === 'string' ? provider : '',
      peerCount: new Set(peers.map((peer) => peer['peerId'])).size,
      reasoning: announcesReasoning(entry['capabilities']) || peers.some((peer) => announcesReasoning(peer['capabilities'])),
      trustedFree: peers.some((peer) => {
        const route = {
          peerId: peer['peerId'] as string,
          effectiveReputationScore: finiteOrNull(peer['effectiveReputationScore']),
          onChainReputationScore: finiteOrNull(peer['onChainReputationScore']),
          reputationScore: finiteOrNull(peer['reputationScore']),
          inputUsdPerMillion: finiteOrNull(peer['inputUsdPerMillion']),
          outputUsdPerMillion: finiteOrNull(peer['outputUsdPerMillion']),
        };
        const cached = finiteOrNull(peer['cachedInputUsdPerMillion']);
        return modelRouteTotalPrice(route) === 0 && (cached === null || cached <= 0) && isModelRouteEligible(route, preferences);
      }),
    });
  }
  // The lineup takes each slot's first match, so most-sold models win.
  catalog.sort((a, b) => b.peerCount - a.peerCount || a.label.localeCompare(b.label));
  const keyOf = (row: CatalogRow) => canonicalModelKey(row.serviceId) || row.serviceId;

  const selected = inputs.defaultRoutedModel ? inputs.defaultRoutedModel.slice(inputs.defaultRoutedModel.indexOf('@') + 1) : '';
  const selectedKey = selected ? canonicalModelKey(selected) || selected : '';
  const favorites = new Set((inputs.favoriteModels ?? []).map((key) => canonicalModelKey(key) || key));
  const ordered = [
    ...catalog.filter((row) => keyOf(row) === selectedKey),
    ...catalog.filter((row) => favorites.has(keyOf(row))),
    ...selectRecommendedModels(catalog, { keyOf, hasTrustedFreeSeller: (row) => row.trustedFree }),
  ];
  const seen = new Set<string>();
  return ordered
    .filter((row) => !seen.has(keyOf(row)) && seen.add(keyOf(row)))
    .map((row) => ({
      label: row.label,
      model: row.serviceId,
      provider: row.provider,
      ...(row.reasoning ? { reasoning: true as const } : {}),
      ...(favorites.has(keyOf(row)) ? { favorite: true as const } : {}),
    }));
}
