import { resolveRoutingPreferences, validateRoutingPreferenceSchema, type RoutingPreferences, type RoutingPreferenceSchema } from './routing-preferences.js';

/** Service API protocol advertised by sellers that recommend inference destinations. */
export const MODEL_ROUTING_PROTOCOL = 'model-routing';
export const MODEL_ROUTING_DESCRIBE_PATH = '/v1/routing/describe';
export const MODEL_ROUTING_RANK_PATH = '/v1/routing/rank';

/** Free description of a router: the models it understands and the settings it accepts. */
export type RoutingDescribeResponseV1 = {
  revision: string;
  supportedServiceIds: string[];
  preferences: RoutingPreferenceSchema;
  name?: string;
  description?: string;
};

/** One peer/provider/model destination the buyer allows, with its price and expected cache reuse. */
export type RoutingCandidateV1 = {
  model: string;
  peer: string;
  provider: string;
  price: {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
    cachedInputUsdPerMillion?: number;
  };
  /**
   * What the buyer already knows about usage on this candidate (Inference Routing Protocol
   * `expected_usage`). `cache_read_tokens`: prompt tokens this exact peer/provider/model is
   * expected to serve from its prompt cache. Absent means 0.
   */
  expected_usage?: { cache_read_tokens?: number };
};

/**
 * The inference request being routed, as an OpenAI Chat Completions body (same convention as
 * the Inference Routing Protocol's `request`). Buyers convert Anthropic Messages and Responses
 * bodies before sending. Routers ignore `model` and `stream`; they never forward it.
 */
export type RoutingInferenceRequestV1 = {
  messages: Array<{ role: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

export type RoutingRankRequestV1 = {
  /** AntSeed routing service ID being purchased; sellers use it to match the paid offer. */
  service: string;
  revision: string;
  preferences: RoutingPreferences;
  request: RoutingInferenceRequestV1;
  candidates: RoutingCandidateV1[];
};

export type RoutingRecommendationV1 = {
  model: string;
  peer: string;
  provider: string;
};

export type RoutingRankResponseV1 = {
  recommendations: RoutingRecommendationV1[];
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maxLength = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function peerId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function price(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const CHAT_ROLES = new Set(['developer', 'system', 'user', 'assistant', 'tool', 'function']);

/** A Chat Completions body with at least one message, each with a known role. */
function chatRequest(value: unknown): value is RoutingInferenceRequestV1 {
  return object(value) && Array.isArray(value.messages) && value.messages.length > 0
    && value.messages.every(message => object(message) && typeof message.role === 'string' && CHAT_ROLES.has(message.role));
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Stable key for matching recommendations to candidates. */
export function routingCandidateKey(entry: { model: string; peer: string; provider: string }): string {
  return JSON.stringify([entry.peer, entry.provider, entry.model]);
}

export function validateRoutingDescribeResponse(value: unknown): asserts value is RoutingDescribeResponseV1 {
  if (!object(value) || !onlyKeys(value, ['revision', 'supportedServiceIds', 'preferences', 'name', 'description'])
    || !text(value.revision, 128) || !Array.isArray(value.supportedServiceIds)
    || !value.supportedServiceIds.every(entry => text(entry))
    || new Set(value.supportedServiceIds).size !== value.supportedServiceIds.length
    || (value.name !== undefined && !text(value.name, 128))
    || (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 1024))) {
    throw new Error('Invalid model-routing describe response');
  }
  validateRoutingPreferenceSchema(value.preferences);
}

/** Optional `expected_usage`; `cache_read_tokens` is optional and defaults to 0. */
function expectedUsage(value: unknown): boolean {
  if (value === undefined) return true;
  return object(value) && onlyKeys(value, ['cache_read_tokens'])
    && (value.cache_read_tokens === undefined || count(value.cache_read_tokens));
}

function validateCandidate(value: unknown): asserts value is RoutingCandidateV1 {
  if (!object(value) || !onlyKeys(value, ['model', 'peer', 'provider', 'price', 'expected_usage'])
    || !text(value.model) || !peerId(value.peer) || !text(value.provider, 128)
    || !object(value.price) || !onlyKeys(value.price, ['inputUsdPerMillion', 'outputUsdPerMillion', 'cachedInputUsdPerMillion'])
    || !price(value.price.inputUsdPerMillion) || !price(value.price.outputUsdPerMillion)
    || (value.price.cachedInputUsdPerMillion !== undefined && !price(value.price.cachedInputUsdPerMillion))
    || !expectedUsage(value.expected_usage)) {
    throw new Error('Invalid model-routing candidate');
  }
}

/**
 * Check a rank request against the router's current description. Routers call this before
 * ranking; buyers call it before paying so malformed requests never leave the device.
 */
export function validateRoutingRankRequest(value: unknown, description: RoutingDescribeResponseV1): asserts value is RoutingRankRequestV1 {
  validateRoutingDescribeResponse(description);
  if (!object(value) || !onlyKeys(value, ['service', 'revision', 'preferences', 'request', 'candidates'])
    || !text(value.service) || typeof value.revision !== 'string' || !chatRequest(value.request)
    || !Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new Error('Invalid model-routing rank request');
  }
  if (value.revision !== description.revision) throw new Error('Router description changed; refresh it');
  const supported = new Set(description.supportedServiceIds);
  const keys = new Set<string>();
  for (const candidate of value.candidates) {
    validateCandidate(candidate);
    if (!supported.has(candidate.model)) throw new Error(`Router does not support model ${candidate.model}`);
    const key = routingCandidateKey(candidate);
    if (keys.has(key)) throw new Error('Duplicate model-routing candidate');
    keys.add(key);
  }
  resolveRoutingPreferences(description.preferences, value.preferences);
}

/**
 * Keep recommendations that name a sent candidate, in the router's order. Invalid entries
 * and duplicates are dropped.
 * Throws when the response shape is invalid or no entry survives.
 */
export function validateRoutingRankResponse(value: unknown, candidates: readonly RoutingCandidateV1[]): RoutingRecommendationV1[] {
  if (!object(value) || !onlyKeys(value, ['recommendations'])
    || !Array.isArray(value.recommendations) || value.recommendations.length === 0) {
    throw new Error('Invalid model-routing rank response');
  }
  const byKey = new Map(candidates.map(candidate => [routingCandidateKey(candidate), candidate]));
  const seen = new Set<string>();
  const accepted: RoutingRecommendationV1[] = [];
  for (const entry of value.recommendations) {
    if (!object(entry) || !onlyKeys(entry, ['model', 'peer', 'provider'])
      || typeof entry.model !== 'string' || typeof entry.peer !== 'string' || typeof entry.provider !== 'string') continue;
    const key = routingCandidateKey({ model: entry.model, peer: entry.peer, provider: entry.provider });
    const candidate = byKey.get(key);
    if (!candidate || seen.has(key)) continue;
    seen.add(key);
    accepted.push({ model: candidate.model, peer: candidate.peer, provider: candidate.provider });
  }
  if (!accepted.length) throw new Error('Router returned no recommendation among the sent candidates');
  return accepted;
}
