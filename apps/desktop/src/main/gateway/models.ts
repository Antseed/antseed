/**
 * The gateway's model list (`GET /v1/models`), shared by the chat picker and
 * the connected apps' configs. A gateway in front of an Antseed buyer returns
 * the buyer's extended entries (`name`, `type`, `peers[]`); any other
 * OpenAI-compatible endpoint returns plain `{ id }` entries, which work too.
 */
import { isServiceHealthFailing } from '@antseed/node';
import { DEFAULT_MODEL_ROUTING_PREFERENCES, isModelRouteEligible } from '@antseed/node/model-routing';
import { record } from './response-fields.js';
import type { GatewayEndpoint } from './service.js';

export type GatewayModelEntry = Record<string, unknown> & { id: string };

export type GatewayModel = {
  id: string;
  label: string;
  /** `text`, `image`, `video`, `speech`, … as the gateway reports it; null when it does not say. */
  type: string | null;
  /** Some seller reports reasoning support, so apps can offer effort levels for it. */
  reasoning: boolean;
};

const CACHE_TTL_MS = 60_000;
let cache: { key: string; at: number; entries: GatewayModelEntry[] } | null = null;

/** Raw `/v1/models` entries, cached for a minute per endpoint+key. */
export async function fetchGatewayModelEntries(endpoint: GatewayEndpoint, options: { force?: boolean } = {}): Promise<GatewayModelEntry[]> {
  const cacheKey = `${endpoint.origin}\u0000${endpoint.apiKey}`;
  if (!options.force && cache && cache.key === cacheKey && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries;
  const response = await fetch(`${endpoint.origin}/v1/models`, {
    headers: { authorization: `Bearer ${endpoint.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`The gateway's model list failed (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const body = await response.json() as { data?: unknown };
  const entries = (Array.isArray(body.data) ? body.data : [])
    .filter((entry): entry is GatewayModelEntry => (
      Boolean(entry) && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
    ))
    // `_`-prefixed ids are services a seller marks as off (`_disabled_<model>`); never offer them.
    .filter((entry) => !entry.id.startsWith('_'));
  cache = { key: cacheKey, at: Date.now(), entries };
  return entries;
}

/**
 * Whether the model can reason: the entry says every seller does, or one of
 * its sellers reports it, as the chat picker counts it. False for a plain
 * OpenAI-compatible entry, which carries neither.
 */
export function entryReasons(entry: GatewayModelEntry): boolean {
  return record(entry['capabilities'])['reasoning'] === true
    || (Array.isArray(entry['peers']) && entry['peers'].some((peer) => record(record(peer)['capabilities'])['reasoning'] === true));
}

/**
 * Trust that a seller needs before the connected apps list its model: the
 * routing default (`minTrustScore`), so apps list the models automatic
 * routing would use even when the buyer's own minimum is lower.
 */
export const APP_MODEL_MIN_TRUST = DEFAULT_MODEL_ROUTING_PREFERENCES.minTrustScore;

/**
 * Whether one of the entry's sellers is trusted and its last health check is
 * not failing, judged as automatic routing judges it (the routing defaults,
 * whose peer lists are empty, so only trust counts). A plain
 * OpenAI-compatible entry has no `peers` to judge and is kept.
 */
export function entryHasTrustedSeller(entry: GatewayModelEntry, minTrust: number = APP_MODEL_MIN_TRUST): boolean {
  if (!Array.isArray(entry['peers'])) return true;
  const preferences = { ...DEFAULT_MODEL_ROUTING_PREFERENCES, minTrustScore: minTrust };
  return entry['peers'].some((value) => {
    const peer = record(value);
    if (typeof peer['peerId'] !== 'string') return false;
    if (isServiceHealthFailing(peer['health'] as Parameters<typeof isServiceHealthFailing>[0])) return false;
    return isModelRouteEligible({ ...peer, peerId: peer['peerId'] }, preferences);
  });
}

/** The type the apps group an entry under: as the gateway reports it, `text` when it does not say. */
function entryTypeKey(entry: GatewayModelEntry): string {
  const type = typeof entry['type'] === 'string' ? entry['type'].trim().toLowerCase() : '';
  return type || 'text';
}

/**
 * The entries the connected apps list: models with a trusted seller. Each
 * type (text, image, …) is judged on its own: when none of a type's models
 * has one (a fresh network, a testbench), every model of that type is kept,
 * so a trusted image model alone can't leave an app without text models.
 */
export function trustedAppEntries(entries: GatewayModelEntry[], minTrust: number = APP_MODEL_MIN_TRUST): GatewayModelEntry[] {
  const trusted = new Set(entries.filter((entry) => entryHasTrustedSeller(entry, minTrust)));
  const typesWithTrusted = new Set([...trusted].map(entryTypeKey));
  return entries.filter((entry) => trusted.has(entry) || !typesWithTrusted.has(entryTypeKey(entry)));
}

export function toGatewayModel(entry: GatewayModelEntry): GatewayModel {
  const name = typeof entry['name'] === 'string' && entry['name'].trim() ? entry['name'].trim() : entry.id;
  const type = typeof entry['type'] === 'string' ? entry['type'] : null;
  return { id: entry.id, label: name, type, reasoning: entryReasons(entry) };
}
export function clearGatewayModelCache(): void {
  cache = null;
}
