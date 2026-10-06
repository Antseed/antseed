/**
 * AntSeed's binding of Inference Routing Protocol (IRP) suggest-only mode:
 * https://github.com/inference-routing/spec/blob/main/SPEC.md
 * Bodies are plain IRP. The purchased routing service travels in the `x-antseed-service`
 * header, like `x-antseed-provider`, so no AntSeed data is added to the bodies.
 */

/** Service API protocol advertised by sellers that rank inference destinations. */
export const MODEL_ROUTING_PROTOCOL = 'model-routing';
/** IRP §4: the router's supported models (free on AntSeed). */
export const MODEL_ROUTING_MODELS_PATH = '/v1/routing/models';
/** IRP §5: suggest-only ranking (one completed request on AntSeed). */
export const MODEL_ROUTING_RANK_PATH = '/v1/routing/rank';
/** Header naming the AntSeed routing service a models or rank request is for. */
export const ROUTING_SERVICE_HEADER = 'x-antseed-service';
export const ROUTING_RANKING_OBJECT = 'routing.ranking';
export const MAX_ROUTING_CANDIDATES = 512;
export const MAX_ROUTING_CANDIDATE_ID_LENGTH = 128;
/** IRP default when `cost_quality_tradeoff` is absent. */
export const DEFAULT_COST_QUALITY_TRADEOFF = 5;

/** IRP §4 `GET /v1/routing/models` response. */
export type RoutingModelsResponseV1 = {
  object: 'list';
  data: Array<{ id: string; object: 'model' }>;
};

/** IRP §3.2 candidate. */
export type RoutingCandidateV1 = {
  id: string;
  model: string;
  /** USD per 1M tokens. */
  pricing: { input: number; cache_read: number; output: number };
  /** Absent means 0 cache reads. */
  expected_usage?: { cache_read_tokens?: number };
};

/**
 * The inference request being ranked, as an OpenAI Chat Completions body (IRP `request`).
 * Routers ignore `model` and `stream`; they never forward it.
 */
export type RoutingInferenceRequestV1 = {
  messages: Array<{ role: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

/** IRP §5.1 `POST /v1/routing/rank`. */
export type RoutingRankRequestV1 = {
  request: RoutingInferenceRequestV1;
  routing: {
    /** 0 = best quality regardless of price, 10 = cheapest acceptable. Default 5. */
    cost_quality_tradeoff?: number;
    candidates: RoutingCandidateV1[];
  };
};

/** IRP §3.4 ranked entry. Only `candidate_id` is required. */
export type RoutingRankedEntryV1 = {
  candidate_id: string;
  expected_quality?: number;
  expected_cost_usd?: number;
  expected_usage?: { input_tokens: number; cache_read_tokens: number; output_tokens: number };
  reasoning_effort?: string;
};

/** IRP §5.2 response. */
export type RoutingRankResponseV1 = {
  id: string;
  object: typeof ROUTING_RANKING_OBJECT;
  created: number;
  router: { id: string; version: string };
  ranked: RoutingRankedEntryV1[];
};

/** IRP §8 problem types. */
export const ROUTING_PROBLEM_TYPES = {
  invalidRequest: 'urn:irp:problem:invalid-request',
  paymentRequired: 'urn:irp:problem:payment-required',
  noScorableCandidate: 'urn:irp:problem:no-scorable-candidate',
  unavailable: 'urn:irp:problem:unavailable',
} as const;

export type RoutingProblem = { type?: string; title?: string; status?: number; detail?: string };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maxLength = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function price(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** An IRP `cost_quality_tradeoff`: an integer 0-10. */
export function isCostQualityTradeoff(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10;
}

const CHAT_ROLES = new Set(['developer', 'system', 'user', 'assistant', 'tool', 'function']);

/** A Chat Completions body with at least one message, each with a known role. */
function chatRequest(value: unknown): value is RoutingInferenceRequestV1 {
  return object(value) && Array.isArray(value.messages) && value.messages.length > 0
    && value.messages.every(message => object(message) && typeof message.role === 'string' && CHAT_ROLES.has(message.role));
}

/** The routing service named by the `x-antseed-service` header, if any. */
export function routingServiceFromHeaders(headers: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === ROUTING_SERVICE_HEADER && typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Validate `GET /v1/routing/models` and return the model IDs. Unknown members are ignored (IRP §2). */
export function parseRoutingModelsResponse(value: unknown): string[] {
  if (!object(value) || value.object !== 'list' || !Array.isArray(value.data)) {
    throw new Error('Invalid routing models response: expected an IRP model list');
  }
  const models = value.data.map(entry => {
    if (!object(entry) || entry.object !== 'model' || !text(entry.id)) throw new Error('Invalid routing models response: each model needs an id');
    return entry.id;
  });
  if (new Set(models).size !== models.length) throw new Error('Invalid routing models response: duplicate model id');
  return models;
}

function validateCandidate(value: unknown): asserts value is RoutingCandidateV1 {
  if (!object(value) || !text(value.id, MAX_ROUTING_CANDIDATE_ID_LENGTH) || !text(value.model)
    || !object(value.pricing) || !price(value.pricing.input) || !price(value.pricing.cache_read) || !price(value.pricing.output)
    || (value.expected_usage !== undefined && (!object(value.expected_usage)
      || (value.expected_usage.cache_read_tokens !== undefined && !count(value.expected_usage.cache_read_tokens))))) {
    throw new Error('Invalid model-routing candidate');
  }
}

/**
 * Check a rank request. Buyers call it before paying so malformed requests never leave the
 * device; routers can call it before ranking. With `supportedModels`, every candidate must
 * use a listed model. Unknown members are ignored (IRP §2).
 */
export function validateRoutingRankRequest(value: unknown, supportedModels?: readonly string[]): asserts value is RoutingRankRequestV1 {
  const routing = object(value) && object(value.routing) ? value.routing : undefined;
  if (!object(value) || !chatRequest(value.request) || !routing
    || !Array.isArray(routing.candidates) || routing.candidates.length === 0 || routing.candidates.length > MAX_ROUTING_CANDIDATES
    || (routing.cost_quality_tradeoff !== undefined && !isCostQualityTradeoff(routing.cost_quality_tradeoff))) {
    throw new Error('Invalid model-routing rank request');
  }
  const supported = supportedModels ? new Set(supportedModels) : null;
  const ids = new Set<string>();
  for (const candidate of routing.candidates) {
    validateCandidate(candidate);
    if (supported && !supported.has(candidate.model)) throw new Error(`Router does not support model ${candidate.model}`);
    if (ids.has(candidate.id)) throw new Error('Duplicate model-routing candidate id');
    ids.add(candidate.id);
  }
}

/**
 * Validate an IRP ranking and keep entries naming a sent candidate, in the router's order
 * (IRP §5.3: clients reject unknown `candidate_id`s). Duplicates and malformed entries are
 * dropped; optional predictions are kept only when well-formed.
 * Throws when the envelope is invalid or no entry survives.
 */
export function validateRoutingRankResponse(value: unknown, candidates: readonly Pick<RoutingCandidateV1, 'id'>[]): RoutingRankedEntryV1[] {
  if (!object(value) || value.object !== ROUTING_RANKING_OBJECT || !text(value.id) || !count(value.created)
    || !object(value.router) || typeof value.router.id !== 'string' || typeof value.router.version !== 'string'
    || !Array.isArray(value.ranked) || value.ranked.length === 0) {
    throw new Error('Invalid model-routing rank response');
  }
  const sent = new Set(candidates.map(candidate => candidate.id));
  const seen = new Set<string>();
  const accepted: RoutingRankedEntryV1[] = [];
  for (const entry of value.ranked) {
    if (!object(entry) || typeof entry.candidate_id !== 'string' || !sent.has(entry.candidate_id) || seen.has(entry.candidate_id)) continue;
    seen.add(entry.candidate_id);
    const usage = entry.expected_usage;
    accepted.push({
      candidate_id: entry.candidate_id,
      ...(typeof entry.expected_quality === 'number' && entry.expected_quality >= 0 && entry.expected_quality <= 1 ? { expected_quality: entry.expected_quality } : {}),
      ...(price(entry.expected_cost_usd) ? { expected_cost_usd: entry.expected_cost_usd } : {}),
      ...(object(usage) && count(usage.input_tokens) && count(usage.cache_read_tokens) && count(usage.output_tokens)
        ? { expected_usage: { input_tokens: usage.input_tokens, cache_read_tokens: usage.cache_read_tokens, output_tokens: usage.output_tokens } }
        : {}),
      ...(text(entry.reasoning_effort, 32) ? { reasoning_effort: entry.reasoning_effort } : {}),
    });
  }
  if (!accepted.length) throw new Error('Router returned no ranking among the sent candidates');
  return accepted;
}

/** IRP §8 Problem Details (RFC 9457), when the body is one. */
export function parseRoutingProblem(body: unknown): RoutingProblem | null {
  if (!object(body)) return null;
  const problem: RoutingProblem = {
    ...(typeof body.type === 'string' ? { type: body.type } : {}),
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.status === 'number' ? { status: body.status } : {}),
    ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
  };
  return problem.type || problem.title || problem.detail ? problem : null;
}

/** A serialized IRP problem response body (`application/problem+json`). */
export function routingProblemBody(status: number, type: string, title: string, detail?: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type, title, status, ...(detail ? { detail } : {}) }));
}
