/**
 * Which sellers a model would route to under this app's key and its routing
 * policy — the gateway console's route preview, read with the key itself: an
 * API key may sign in to the console API and preview its own routing. The
 * chat's seller picker shows it, so Auto and every pin stay inside the policy
 * (the gateway refuses a pinned seller the policy excludes anyway).
 */
import { splitPinnedModel } from '../../shared/pinned-model.js';
import type { GatewayEndpoint } from './service.js';

export type RouteCandidate = {
  peerId: string;
  name: string | null;
  rank: number | null;
  eligible: boolean;
  reasons: string[];
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  trustScore: number | null;
  successRate: number | null;
  firstTokenMs: number | null;
  tokensPerSecond: number | null;
  failing: boolean;
};

export type RoutePreview = {
  model: string;
  modelAllowed: boolean;
  sort: string | null;
  candidates: RouteCandidate[];
};

const CONSOLE_CSRF_HEADER = 'x-antseed-console';
const CACHE_TTL_MS = 30_000;

let session: { key: string; cookie: string } | null = null;
const cache = new Map<string, { at: number; preview: RoutePreview }>();

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The `name=value` pairs of every Set-Cookie header, joined for a Cookie header. */
function cookieHeader(response: Response): string {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? ''];
  return raw.map((line) => line.split(';')[0]!.trim()).filter((pair) => pair.includes('=')).join('; ');
}

async function signIn(endpoint: GatewayEndpoint): Promise<string> {
  const response = await fetch(`${endpoint.origin}/console/api/auth/api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CONSOLE_CSRF_HEADER]: '1' },
    body: JSON.stringify({ key: endpoint.apiKey }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`The gateway refused the key's console sign-in (HTTP ${response.status})`);
  const cookie = cookieHeader(response);
  if (!cookie) throw new Error('The gateway did not start a console session for the key');
  return cookie;
}

async function sessionCookie(endpoint: GatewayEndpoint, renew: boolean): Promise<string> {
  const id = `${endpoint.origin}\u0000${endpoint.apiKey}`;
  if (!renew && session?.key === id) return session.cookie;
  const cookie = await signIn(endpoint);
  session = { key: id, cookie };
  return cookie;
}

export function parseRoutePreview(body: unknown): RoutePreview {
  const data = obj(body);
  const policy = obj(data['policy']);
  const sources = Array.isArray(data['sources']) ? data['sources'].map(obj) : [];
  const buyerSort = obj(sources.find((source) => source['level'] === 'buyer')?.['policy'])['sort'];
  const sort = typeof policy['sort'] === 'string' ? policy['sort'] : typeof buyerSort === 'string' ? buyerSort : null;
  const candidates = (Array.isArray(data['candidates']) ? data['candidates'] : []).map(obj)
    .filter((candidate) => typeof candidate['peerId'] === 'string')
    .map((candidate): RouteCandidate => {
      const selection = obj(candidate['selection']);
      const health = obj(candidate['health']);
      const name = typeof candidate['displayName'] === 'string' && candidate['displayName'].trim() ? candidate['displayName'].trim() : null;
      return {
        peerId: String(candidate['peerId']).toLowerCase().replace(/^0x/, ''),
        name,
        rank: num(candidate['rank']),
        eligible: candidate['eligible'] === true,
        reasons: Array.isArray(candidate['reasons']) ? candidate['reasons'].filter((reason): reason is string => typeof reason === 'string') : [],
        inputUsdPerMillion: num(candidate['inputUsdPerMillion']),
        outputUsdPerMillion: num(candidate['outputUsdPerMillion']),
        trustScore: num(candidate['trustScore']),
        successRate: num(selection['successRate']),
        firstTokenMs: num(selection['firstTokenMs']),
        tokensPerSecond: num(selection['tokensPerSecond']),
        failing: selection['failing'] === true || health['status'] === 'failing',
      };
    })
    // Eligible sellers in Auto's order, then the excluded ones.
    .sort((left, right) => Number(right.eligible) - Number(left.eligible)
      || (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER));
  return {
    model: typeof data['model'] === 'string' ? data['model'] : '',
    modelAllowed: data['modelAllowed'] !== false,
    sort,
    candidates,
  };
}

/** The key's route preview for `model` (a pinned `peer@model` previews its model), cached briefly. */
export async function fetchRoutePreview(endpoint: GatewayEndpoint, model: string, options: { force?: boolean } = {}): Promise<RoutePreview> {
  const { modelId } = splitPinnedModel(model);
  const cacheKey = `${endpoint.origin}\u0000${endpoint.apiKey}\u0000${modelId}`;
  const cached = cache.get(cacheKey);
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.preview;

  const request = async (renew: boolean): Promise<Response> => fetch(
    `${endpoint.origin}/console/api/route-preview?model=${encodeURIComponent(modelId)}`,
    { headers: { cookie: await sessionCookie(endpoint, renew), accept: 'application/json' }, signal: AbortSignal.timeout(20_000) },
  );
  let response = await request(false);
  // An expired or revoked session: sign in again once.
  if (response.status === 401) response = await request(true);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`The gateway's route preview failed (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const preview = parseRoutePreview(await response.json());
  cache.set(cacheKey, { at: Date.now(), preview });
  return preview;
}

export function clearRoutePreviewCache(): void {
  cache.clear();
  session = null;
}
