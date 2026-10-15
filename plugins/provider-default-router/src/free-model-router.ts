import { randomUUID } from 'node:crypto';
import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';
import {
  MODEL_ROUTING_ANY_MODEL,
  MODEL_ROUTING_MODELS_PATH,
  MODEL_ROUTING_RANK_PATH,
  ROUTING_PROBLEM_TYPES,
  routingProblemBody,
  validateRoutingRankRequest,
  type RoutingCandidateV1,
  type RoutingModelEntryV1,
} from '@antseed/node';
import { canonicalModelKey } from '@antseed/node/model-identity';

export const DEFAULT_ROUTER_ID = 'antseed-default-router';
export const DEFAULT_ROUTER_VERSION = '0.1.0';
export const DEFAULT_SCORES_URL = 'https://modelgrep.com/api/v1/models';
export const DEFAULT_REFRESH_MS = 6 * 60 * 60_000;

/** Deployment suffixes that do not change the model: `-fast`, `-pro`, quantisations, dates. */
const FREE_PRICING = { input: 0, cache_read: 0, output: 0 };
const VARIANT_SUFFIX = /[-_.:](?:free|fast|ultrafast|fast-api|highspeed|turbo|preview|exl\d|fp\d+|nvfp\d|bf16|int\d|awq|gguf|instruct|it|\d{4}|\d{6,8})$/i;
const SCORE_PAGE_SIZE = 200;
const MAX_SCORE_PAGES = 10;

export type ScoreMetric = 'intelligence' | 'coding';

type ScoredModel = { id?: unknown; benchmarks?: { artificial_analysis?: Record<string, unknown> | null } | null };
export type ScoresPage = { data?: ScoredModel[]; meta?: { has_more?: boolean; next_offset?: number } };

export type FreeModelRouterOptions = {
  /** Which Artificial Analysis index to rank by. */
  metric?: ScoreMetric;
  /** Seller-preferred models, best first. They outrank every scored model. */
  preferredModels?: string[];
  /** Also rank paid candidates, after every free one, cheapest first. */
  includePaid?: boolean;
  /** modelgrep-compatible model list with Artificial Analysis scores. Empty disables scores. */
  scoresUrl?: string;
  refreshMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
};

const isFreeCandidate = (candidate: RoutingCandidateV1): boolean =>
  candidate.pricing.input === 0 && candidate.pricing.output === 0 && candidate.pricing.cache_read === 0;

/** Canonical keys for a model id, most specific first: the id itself, then with variant suffixes removed. */
export function modelKeys(id: string): string[] {
  const keys: string[] = [];
  let name = id.trim();
  for (let step = 0; step < 4 && name; step++) {
    const key = canonicalModelKey(name);
    if (key && !keys.includes(key)) keys.push(key);
    const stripped = name.replace(VARIANT_SUFFIX, '');
    if (stripped === name) break;
    name = stripped;
  }
  return keys;
}

/** Scores by canonical model key from modelgrep pages. Models without the metric are left out. */
export function parseScores(pages: ScoresPage[], metric: ScoreMetric): Map<string, number> {
  const scores = new Map<string, number>();
  for (const page of pages) {
    for (const model of page.data ?? []) {
      const value = model.benchmarks?.artificial_analysis?.[metric];
      if (typeof model.id !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) continue;
      const key = canonicalModelKey(model.id.replace(/:free$/, ''));
      if (key && !scores.has(key)) scores.set(key, value);
    }
  }
  return scores;
}

function json(requestId: string, statusCode: number, value: unknown): SerializedHttpResponse {
  return { requestId, statusCode, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(value)) };
}

function problem(requestId: string, statusCode: number, type: string, title: string, detail: string): SerializedHttpResponse {
  return { requestId, statusCode, headers: { 'content-type': 'application/problem+json' }, body: routingProblemBody(statusCode, type, title, detail) };
}

/**
 * AntSeed's default model router: a suggest-only IRP router that sends buyers to the best
 * free model among their candidates. It answers both IRP endpoints itself and forwards nothing.
 *
 * Free candidates are ranked by their live Artificial Analysis score (via modelgrep). Models
 * without a score are still ranked, after every scored model. Candidates of equal score keep
 * the buyer's order, which already reflects its trust and failure history.
 */
export class FreeModelRouter {
  private scores = new Map<string, number>();
  private loadedAt = -Infinity;
  private refreshing: Promise<void> | null = null;
  private readonly preferred: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: FreeModelRouterOptions = {}) {
    this.preferred = [...new Set(options.preferredModels ?? [])];
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    await this.refresh();
  }

  /**
   * `GET /v1/routing/models`: `*` (any model the buyer sends) plus the seller's preferred
   * models. Candidates come from the buyer's own catalog, so no network-wide list is needed.
   * Unless paid candidates are ranked, every entry carries a zero `max_pricing` so buyers
   * send only free candidates.
   */
  listModels(): RoutingModelEntryV1[] {
    return [MODEL_ROUTING_ANY_MODEL, ...this.preferred]
      .map(id => (this.options.includePaid ? { id } : { id, max_pricing: { ...FREE_PRICING } }));
  }

  async handleRequest(request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    const path = request.path.split('?')[0];
    if (request.method === 'GET' && path === MODEL_ROUTING_MODELS_PATH) {
      return json(request.requestId, 200, { object: 'list', data: this.listModels().map(entry => ({ ...entry, object: 'model' })) });
    }
    if (request.method === 'POST' && path === MODEL_ROUTING_RANK_PATH) return this.rank(request);
    return problem(request.requestId, 404, ROUTING_PROBLEM_TYPES.invalidRequest, 'Not found', `${request.method} ${path} is not a routing endpoint.`);
  }

  private async rank(request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(request.body));
      validateRoutingRankRequest(body);
    } catch (error) {
      return problem(request.requestId, 400, ROUTING_PROBLEM_TYPES.invalidRequest, 'Invalid request', error instanceof Error ? error.message : String(error));
    }
    await this.refreshIfStale();
    const candidates = body.routing.candidates;
    const score = this.scorer();
    const free = candidates.filter(isFreeCandidate)
      .map((candidate, index) => ({ candidate, index, score: score(candidate.model) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ candidate }) => ({ candidate_id: candidate.id, expected_cost_usd: 0 }));
    const paid = this.options.includePaid
      ? candidates.filter(candidate => !isFreeCandidate(candidate))
        .map((candidate, index) => ({ candidate, index, price: candidate.pricing.input + candidate.pricing.output }))
        .sort((a, b) => a.price - b.price || a.index - b.index)
        .map(({ candidate }) => ({ candidate_id: candidate.id }))
      : [];
    const ranked = [...free, ...paid];
    if (!ranked.length) {
      return problem(request.requestId, 422, ROUTING_PROBLEM_TYPES.noScorableCandidate, 'No free candidate', 'None of the candidates is free.');
    }
    return json(request.requestId, 200, {
      id: `rank_${randomUUID()}`,
      object: 'routing.ranking',
      created: Math.floor(this.now() / 1000),
      router: { id: DEFAULT_ROUTER_ID, version: DEFAULT_ROUTER_VERSION },
      ranked,
    });
  }

  /** Preferred models first in their listed order, then live scores; unscored models rank last. */
  private scorer(): (model: string) => number {
    const preferredRank = new Map(this.preferred.map((model, index) => [canonicalModelKey(model), this.preferred.length - index]));
    return model => {
      const keys = modelKeys(model);
      for (const key of keys) {
        const preferred = preferredRank.get(key);
        if (preferred !== undefined) return 1e9 + preferred;
      }
      for (const key of keys) {
        const value = this.scores.get(key);
        if (value !== undefined) return value;
      }
      return -Infinity;
    };
  }

  private async refreshIfStale(): Promise<void> {
    if (this.now() - this.loadedAt >= (this.options.refreshMs ?? DEFAULT_REFRESH_MS)) await this.refresh();
  }

  /** Refresh scores; a failed fetch keeps the last good scores (or ranks by buyer order). */
  private refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const scores = await this.fetchScores().catch(() => null);
      if (scores) this.scores = scores;
      this.loadedAt = this.now();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.json() as T;
  }

  private async fetchScores(): Promise<Map<string, number> | null> {
    const base = this.options.scoresUrl ?? DEFAULT_SCORES_URL;
    if (!base) return null;
    const pages: ScoresPage[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_SCORE_PAGES; page++) {
      const url = new URL(base);
      url.searchParams.set('limit', String(SCORE_PAGE_SIZE));
      url.searchParams.set('offset', String(offset));
      const result = await this.fetchJson<ScoresPage>(url.toString());
      pages.push(result);
      if (!result.meta?.has_more || typeof result.meta.next_offset !== 'number' || result.meta.next_offset <= offset) break;
      offset = result.meta.next_offset;
    }
    return parseScores(pages, this.options.metric ?? 'intelligence');
  }
}
