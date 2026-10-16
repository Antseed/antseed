/**
 * The `irp-suggest` routing protocol: Inference Routing Protocol (IRP) suggest-only mode,
 * https://github.com/inference-routing/spec/blob/main/SPEC.md
 * It is one routing protocol among others (see `./routing.ts`), not a default.
 * Requests are plain IRP paths and bodies. IRP paths name no service, so a seller offers at
 * most one `irp-suggest` service and the path alone identifies the service being bought.
 */
import type { RoutingWireProtocol } from './routing.js';

/** Service API protocol advertised by sellers that rank destinations over IRP suggest-only mode. */
export const IRP_SUGGEST_PROTOCOL = 'irp-suggest';
/** IRP §4: the router's supported models (free on AntSeed). */
export const IRP_MODELS_PATH = '/v1/routing/models';
/** `GET /v1/routing/models` entry meaning the router scores any model the buyer sends. */
export const IRP_ANY_MODEL = '*';
/** IRP §5: suggest-only ranking (one completed request on AntSeed). */
export const IRP_RANK_PATH = '/v1/routing/rank';
export const IRP_RANKING_OBJECT = 'routing.ranking';
export const IRP_MAX_CANDIDATES = 512;
export const IRP_MAX_CANDIDATE_ID_LENGTH = 128;
/** IRP default when `cost_quality_tradeoff` is absent. */
export const IRP_DEFAULT_COST_QUALITY_TRADEOFF = 5;

/** USD per 1M tokens, as on a candidate. */
export type IrpPricing = { input: number; cache_read: number; output: number };

/**
 * A `GET /v1/routing/models` entry. AntSeed extension: on the `*` entry, `max_pricing` caps
 * the candidates the buyer sends through it; an omitted field means no limit.
 */
export type IrpModelEntry = { id: string; max_pricing?: Partial<IrpPricing> };

/** IRP §4 `GET /v1/routing/models` response. */
export type IrpModelsResponse = {
  object: 'list';
  data: Array<IrpModelEntry & { object: 'model' }>;
};

/** IRP §3.2 candidate. */
export type IrpCandidate = {
  id: string;
  model: string;
  /** USD per 1M tokens. */
  pricing: IrpPricing;
  /** Absent means 0 cache reads. */
  expected_usage?: { cache_read_tokens?: number };
};

/**
 * The inference request being ranked, as an OpenAI Chat Completions body (IRP `request`).
 * Routers ignore `model` and `stream`; they never forward it.
 */
export type IrpInferenceRequest = {
  messages: Array<{ role: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

/** IRP §5.1 `POST /v1/routing/rank`. */
export type IrpRankRequest = {
  request: IrpInferenceRequest;
  routing: {
    /** 0 = best quality regardless of price, 10 = cheapest acceptable. Default 5. */
    cost_quality_tradeoff?: number;
    candidates: IrpCandidate[];
  };
};

/** IRP §3.4 ranked entry. Only `candidate_id` is required. */
export type IrpRankedEntry = {
  candidate_id: string;
  expected_quality?: number;
  expected_cost_usd?: number;
  expected_usage?: { input_tokens: number; cache_read_tokens: number; output_tokens: number };
  reasoning_effort?: string;
};

/** IRP §5.2 response. */
export type IrpRankResponse = {
  id: string;
  object: typeof IRP_RANKING_OBJECT;
  created: number;
  router: { id: string; version: string };
  ranked: IrpRankedEntry[];
};

/** IRP §8 problem types. */
export const IRP_PROBLEM_TYPES = {
  invalidRequest: 'urn:irp:problem:invalid-request',
  paymentRequired: 'urn:irp:problem:payment-required',
  noScorableCandidate: 'urn:irp:problem:no-scorable-candidate',
  unavailable: 'urn:irp:problem:unavailable',
} as const;

export type IrpProblem = { type?: string; title?: string; status?: number; detail?: string };

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
function chatRequest(value: unknown): value is IrpInferenceRequest {
  return object(value) && Array.isArray(value.messages) && value.messages.length > 0
    && value.messages.every(message => object(message) && typeof message.role === 'string' && CHAT_ROLES.has(message.role));
}

/** Whether `path` (query string ignored) is an IRP routing endpoint. */
export function isIrpPath(path: string): boolean {
  const pathOnly = path.split('?')[0];
  return pathOnly === IRP_MODELS_PATH || pathOnly === IRP_RANK_PATH;
}

/** Validate `GET /v1/routing/models` and return the model IDs. Unknown members are ignored (IRP §2). */
export function parseIrpModelsResponse(value: unknown): string[] {
  return parseIrpModelEntries(value).map(entry => entry.id);
}

/**
 * Validate `GET /v1/routing/models` and return its entries, keeping `max_pricing` where a
 * router sets it. Unknown members are ignored (IRP §2).
 */
export function parseIrpModelEntries(value: unknown): IrpModelEntry[] {
  if (!object(value) || value.object !== 'list' || !Array.isArray(value.data)) {
    throw new Error('Invalid routing models response: expected an IRP model list');
  }
  const entries = value.data.map((entry): IrpModelEntry => {
    if (!object(entry) || entry.object !== 'model' || !text(entry.id)) throw new Error('Invalid routing models response: each model needs an id');
    if (entry.max_pricing === undefined) return { id: entry.id };
    const limit = entry.max_pricing;
    if (!object(limit) || (['input', 'cache_read', 'output'] as const).some(key => limit[key] !== undefined && !price(limit[key]))) {
      throw new Error('Invalid routing models response: max_pricing needs non-negative prices');
    }
    const maxPricing: Partial<IrpPricing> = {};
    for (const key of ['input', 'cache_read', 'output'] as const) {
      if (limit[key] !== undefined) maxPricing[key] = limit[key] as number;
    }
    return { id: entry.id, max_pricing: maxPricing };
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Invalid routing models response: duplicate model id');
  return entries;
}

/** Whether `pricing` is within `limit`; an omitted limit field allows any price. */
export function withinIrpPricing(pricing: IrpPricing, limit: Partial<IrpPricing> | undefined): boolean {
  return !limit || (['input', 'cache_read', 'output'] as const).every(key => limit[key] === undefined || pricing[key] <= limit[key]!);
}

function validateCandidate(value: unknown): asserts value is IrpCandidate {
  if (!object(value) || !text(value.id, IRP_MAX_CANDIDATE_ID_LENGTH) || !text(value.model)
    || !object(value.pricing) || !price(value.pricing.input) || !price(value.pricing.cache_read) || !price(value.pricing.output)
    || (value.expected_usage !== undefined && (!object(value.expected_usage)
      || (value.expected_usage.cache_read_tokens !== undefined && !count(value.expected_usage.cache_read_tokens))))) {
    throw new Error('Invalid IRP candidate');
  }
}

/**
 * Check a rank request. Buyers call it before paying so malformed requests never leave the
 * device; routers can call it before ranking. With `supportedModels`, every candidate must
 * use a listed model. Unknown members are ignored (IRP §2).
 */
export function validateIrpRankRequest(value: unknown, supportedModels?: readonly string[]): asserts value is IrpRankRequest {
  const routing = object(value) && object(value.routing) ? value.routing : undefined;
  if (!object(value) || !chatRequest(value.request) || !routing
    || !Array.isArray(routing.candidates) || routing.candidates.length === 0 || routing.candidates.length > IRP_MAX_CANDIDATES
    || (routing.cost_quality_tradeoff !== undefined && !isCostQualityTradeoff(routing.cost_quality_tradeoff))) {
    throw new Error('Invalid IRP rank request');
  }
  const supported = supportedModels ? new Set(supportedModels) : null;
  const ids = new Set<string>();
  for (const candidate of routing.candidates) {
    validateCandidate(candidate);
    if (supported && !supported.has(candidate.model)) throw new Error(`Router does not support model ${candidate.model}`);
    if (ids.has(candidate.id)) throw new Error('Duplicate IRP candidate id');
    ids.add(candidate.id);
  }
}

/**
 * Validate an IRP ranking and keep entries naming a sent candidate, in the router's order
 * (IRP §5.3: clients reject unknown `candidate_id`s). Duplicates and malformed entries are
 * dropped; optional predictions are kept only when well-formed.
 * Throws when the envelope is invalid or no entry survives.
 */
export function validateIrpRankResponse(value: unknown, candidates: readonly Pick<IrpCandidate, 'id'>[]): IrpRankedEntry[] {
  if (!object(value) || value.object !== IRP_RANKING_OBJECT || !text(value.id) || !count(value.created)
    || !object(value.router) || typeof value.router.id !== 'string' || typeof value.router.version !== 'string'
    || !Array.isArray(value.ranked) || value.ranked.length === 0) {
    throw new Error('Invalid IRP rank response');
  }
  const sent = new Set(candidates.map(candidate => candidate.id));
  const seen = new Set<string>();
  const accepted: IrpRankedEntry[] = [];
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
export function parseIrpProblem(body: unknown): IrpProblem | null {
  if (!object(body)) return null;
  const problem: IrpProblem = {
    ...(typeof body.type === 'string' ? { type: body.type } : {}),
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.status === 'number' ? { status: body.status } : {}),
    ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
  };
  return problem.type || problem.title || problem.detail ? problem : null;
}

/** A serialized IRP problem response body (`application/problem+json`). */
export function irpProblemBody(status: number, type: string, title: string, detail?: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type, title, status, ...(detail ? { detail } : {}) }));
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

/**
 * What the node and unit billing need from `irp-suggest`: `GET /v1/routing/models` is the free
 * catalog, `POST /v1/routing/rank` the billed ranking, and a ranking is billable when it is a
 * valid IRP ranking naming at least one candidate the request sent.
 */
export const IRP_SUGGEST_WIRE: RoutingWireProtocol = {
  protocol: IRP_SUGGEST_PROTOCOL,
  oneServicePerSeller: true,
  requestAction(method, path) {
    const pathOnly = path.split('?')[0];
    if (method === 'GET' && pathOnly === IRP_MODELS_PATH) return 'catalog';
    if (method === 'POST' && pathOnly === IRP_RANK_PATH) return 'rank';
    return null;
  },
  isProtocolPath: isIrpPath,
  rankCandidateIds(body) {
    const request = parseJson(body);
    const candidates = object(request) && object(request.routing) ? request.routing.candidates : undefined;
    if (!Array.isArray(candidates)) return [];
    return candidates.flatMap(candidate => object(candidate) && typeof candidate.id === 'string' ? [candidate.id] : []);
  },
  isBillableRanking(body, candidateIds) {
    const parsed = parseJson(body);
    if (parsed === undefined || candidateIds.length === 0) return false;
    try {
      validateIrpRankResponse(parsed, candidateIds.map(id => ({ id })));
      return true;
    } catch {
      return false;
    }
  },
  errorResponse(status, reason, detail) {
    const [type, title] = reason === 'no-router'
      ? [IRP_PROBLEM_TYPES.invalidRequest, 'No routing service']
      : [IRP_PROBLEM_TYPES.unavailable, 'Router unavailable'];
    return { contentType: 'application/problem+json', body: irpProblemBody(status, type, title, detail) };
  },
};
