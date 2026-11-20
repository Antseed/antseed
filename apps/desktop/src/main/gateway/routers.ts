/**
 * The routing services the key may use (`GET /v1/models?type=router`, which the
 * buyer answers under the key's routing policy), as rows for the chat's model
 * picker. A router picks the model for each request; the chat sends to it by
 * the `<peerId>@<serviceId>` model each of its sellers offers.
 */
import type { ChatModel } from '../../shared/chat-gateway-types.js';
import { finiteNumber, record } from './response-fields.js';
import type { GatewayEndpoint } from './service.js';

const CACHE_TTL_MS = 60_000;

let cache: { key: string; at: number; routers: ChatModel[] } | null = null;

/** One picker row per seller offering each router; an answer that isn't a list has none. */
export function parseGatewayRouters(payload: unknown): ChatModel[] {
  const data = record(payload)['data'];
  return (Array.isArray(data) ? data : []).map(record).flatMap((entry) => {
    const name = typeof entry['name'] === 'string' && entry['name'].trim() ? entry['name'].trim() : null;
    const peers = (Array.isArray(entry['peers']) ? entry['peers'] : []).map(record);
    return peers.flatMap((peer): ChatModel[] => {
      const model = typeof peer['model'] === 'string' ? peer['model'].trim() : '';
      if (!model) return [];
      const sellerName = typeof peer['displayName'] === 'string' && peer['displayName'].trim() ? peer['displayName'].trim() : null;
      const models = Array.isArray(peer['models']) ? peer['models'].filter((id): id is string => typeof id === 'string') : null;
      return [{
        id: model,
        label: name ?? (typeof entry['id'] === 'string' ? entry['id'] : model),
        type: 'text',
        protocol: 'openai-chat-completions',
        supportsImages: false,
        sellers: 1,
        free: false,
        minImageUsd: null,
        freeSellerId: null,
        freeForStakers: false,
        tee: false,
        toolUse: false,
        reasoning: false,
        inputUsdPerMillion: null,
        outputUsdPerMillion: null,
        router: { sellerName, priceUsdPerRequest: finiteNumber(peer['priceUsdPerRequest']), models: models?.length ?? null },
      }];
    });
  });
}

/** The key's routers, cached for a minute; none from a gateway that doesn't list them. */
export async function fetchGatewayRouters(endpoint: GatewayEndpoint, options: { force?: boolean } = {}): Promise<ChatModel[]> {
  const key = `${endpoint.origin}\u0000${endpoint.apiKey}`;
  if (!options.force && cache?.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.routers;
  const response = await fetch(`${endpoint.origin}/v1/models?type=router`, {
    headers: { authorization: `Bearer ${endpoint.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  // An older gateway rejects the type (400): it has no routers to offer.
  if (response.status === 400 || response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return [];
  }
  if (!response.ok) throw new Error(`The gateway's router list failed (HTTP ${response.status})`);
  const routers = parseGatewayRouters(await response.json());
  cache = { key, at: Date.now(), routers };
  return routers;
}

export function clearGatewayRouterCache(): void {
  cache = null;
}
