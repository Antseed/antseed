/**
 * The gateway's model list (`GET /v1/models`), shared by the chat picker and
 * the connected apps' configs. A gateway in front of an Antseed buyer returns
 * the buyer's extended entries (`name`, `type`, `peers[]`); any other
 * OpenAI-compatible endpoint returns plain `{ id }` entries, which work too.
 */
import type { GatewayEndpoint } from './service.js';

export type GatewayModelEntry = Record<string, unknown> & { id: string };

export type GatewayModel = {
  id: string;
  label: string;
  /** `text`, `image`, `video`, `speech`, … as the gateway reports it; null when it does not say. */
  type: string | null;
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

export function toGatewayModel(entry: GatewayModelEntry): GatewayModel {
  const name = typeof entry['name'] === 'string' && entry['name'].trim() ? entry['name'].trim() : entry.id;
  const type = typeof entry['type'] === 'string' ? entry['type'] : null;
  return { id: entry.id, label: name, type };
}

/** Chat-capable models: those typed `text`, or untyped ones from a plain OpenAI-compatible gateway. */
export async function fetchGatewayTextModels(endpoint: GatewayEndpoint): Promise<GatewayModel[]> {
  const entries = await fetchGatewayModelEntries(endpoint);
  return entries.map(toGatewayModel).filter((model) => model.type === null || model.type === 'text');
}

export function clearGatewayModelCache(): void {
  cache = null;
}
