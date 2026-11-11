/**
 * The gateway's model list (`GET /v1/models`), shared by the chat picker and
 * the connected apps' configs. A gateway in front of an Antseed buyer returns
 * the buyer's extended entries (`name`, `type`, `peers[]`); any other
 * OpenAI-compatible endpoint returns plain `{ id }` entries, which work too.
 */
import { DEFAULT_MODEL_ROUTING_PREFERENCES, modelRouteReputationScore } from '@antseed/node/model-routing';
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
 * Whether one of the entry's sellers is trusted and not reported unhealthy,
 * scored as routing scores them. A plain OpenAI-compatible entry has no
 * `peers` to judge and is kept.
 */
export function entryHasTrustedSeller(entry: GatewayModelEntry, minTrust: number = APP_MODEL_MIN_TRUST): boolean {
  if (!Array.isArray(entry['peers'])) return true;
  return entry['peers'].some((value) => {
    const peer = record(value);
    if (typeof peer['peerId'] !== 'string') return false;
    if (record(peer['health'])['status'] === 'unhealthy') return false;
    const trust = modelRouteReputationScore({ ...peer, peerId: peer['peerId'] });
    return trust !== null && trust >= minTrust;
  });
}

/**
 * The entries the connected apps list: models with a trusted seller. When
 * none has one (a fresh network, a testbench), every entry is kept, so an
 * app still gets models rather than an empty list.
 */
export function trustedAppEntries(entries: GatewayModelEntry[], minTrust: number = APP_MODEL_MIN_TRUST): GatewayModelEntry[] {
  const trusted = entries.filter((entry) => entryHasTrustedSeller(entry, minTrust));
  return trusted.length > 0 ? trusted : entries;
}

export function toGatewayModel(entry: GatewayModelEntry): GatewayModel {
  const name = typeof entry['name'] === 'string' && entry['name'].trim() ? entry['name'].trim() : entry.id;
  const type = typeof entry['type'] === 'string' ? entry['type'] : null;
  return { id: entry.id, label: name, type, reasoning: entryReasons(entry) };
}
export function clearGatewayModelCache(): void {
  cache = null;
}
