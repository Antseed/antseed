import {useEffect, useState} from 'react';
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';
import {createSharedFetch} from './sharedFetch';

/**
 * Live marketplace showcase for the homepage pricing card. No curated
 * model list — the rows are derived entirely from public APIs:
 *
 * - Antscan `/api/marketplace` (CORS: *): every active DHT offering with
 *   its $/M input price, the seller address, and the seller's on-chain
 *   reputation. Only offers from sellers with reputation > 0 count.
 * - OpenRouter `/api/v1/models` (CORS: *, no auth): the model catalog
 *   with official list prices ($/token prompt) and display names.
 * - OpenRouter `/api/frontend/v1/rankings/models?view=week` (CORS: *,
 *   no auth — the endpoint behind openrouter.ai/rankings): weekly token
 *   volume per model, i.e. what the world at large is actually using.
 *
 * Pipeline: group proven offerings by normalized service id, match each
 * group to an OpenRouter model (service ids aren't canonical —
 * "claude-opus-4-8" / "claude-opus-4.8" both normalize to the same key),
 * keep matches from known vendors where the network beats the official
 * price, drop models nobody uses (under MIN_WEEKLY_TOKENS on OpenRouter
 * this week), then rank by RELEASE DATE — the card showcases the good
 * new frontier models (Fable, Kimi, GLM…) as soon as a reputable seller
 * offers them below list price, with vendor variety among the picks.
 *
 * The rankings endpoint is the one unofficial API here (the public v1
 * API ignores its `order=` params); if it disappears the card degrades
 * to network-popularity ordering, never breaks.
 *
 * SSR / API failure shows FALLBACK_ROWS — a dated snapshot of real
 * offers, not invented numbers.
 */

const MARKETPLACE_API = 'https://antscan.co/api/marketplace?limit=1000';
const OPENROUTER_MODELS_API = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_RANKINGS_API = 'https://openrouter.ai/api/frontend/v1/rankings/models?view=week';
const CACHE_KEY = 'as-marketplace-prices-v7';
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Models with less weekly OpenRouter volume than this are noise, not
    "new and good" — skipped when the rankings feed is available. */
const MIN_WEEKLY_TOKENS = 10e9;

/** OpenRouter vendor prefix → LOBE_ICONS key (index.tsx renders the logo).
    Models from vendors outside this map are skipped — no logo to show. */
export const VENDOR_KEYS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
  'meta-llama': 'Meta',
  qwen: 'Qwen',
  mistralai: 'Mistral',
  moonshotai: 'Moonshot',
  'z-ai': 'Zhipu',
  minimax: 'Minimax',
  cohere: 'Cohere',
  nousresearch: 'NousResearch',
  xiaomi: 'XiaomiMiMo',
  tencent: 'Tencent',
  stepfun: 'Stepfun',
  nvidia: 'Nvidia',
  'x-ai': 'XAI',
};

interface Offering {
  service: string;
  sellerAddress: string;
  inputUsdPerMillion: number | null;
  sellerOnChainReputationScore: number | null;
}

/** An offering that counts: priced, and from a seller with on-chain reputation. */
type ProvenOffering = Offering & {inputUsdPerMillion: number};

function isProven(o: Offering): o is ProvenOffering {
  return (
    typeof o.inputUsdPerMillion === 'number' &&
    o.inputUsdPerMillion >= 0 &&
    (o.sellerOnChainReputationScore ?? 0) > 0
  );
}

interface OpenRouterModel {
  /** "minimax/minimax-m2.7" */
  id: string;
  /** dated permaslug, joins to the rankings feed, e.g. "minimax/minimax-m2.7-20260531" */
  canonicalSlug: string;
  /** display name with the vendor stripped, e.g. "MiniMax M2.7" */
  name: string;
  /** vendor label, e.g. "MiniMax" */
  vendorName: string;
  /** official $/M prompt tokens */
  officialUsd: number;
  /** release date, unix seconds — the "new" in "good new models" */
  created: number;
}

/** canonical slug → weekly tokens (prompt + completion) on OpenRouter */
type PopularityMap = Record<string, number>;

export interface ShowcaseRow {
  model: string;
  /** "by MiniMax" */
  vendor: string;
  /** LOBE_ICONS key for the logo, e.g. "Minimax" */
  vendorKey: string;
  /** "$0.25" */
  official: string;
  /** "$0.01" */
  best: string;
  /** "96%" */
  save: string;
  live: boolean;
  /** lowest advertised input price, USD per million tokens */
  bestUsd: number;
  officialUsd: number;
}

/* Last verified live picks (2026-07-30) — real models, official prices,
   and DHT offers at that date. Shown only for SSR and API failure. */
const FALLBACK_ROWS: ShowcaseRow[] = [
  {model: 'Kimi K2.7 Code', vendor: 'by MoonshotAI', vendorKey: 'Moonshot', official: '$0.73', best: '$0.45', save: '38%', live: false, bestUsd: 0.45, officialUsd: 0.73},
  {model: 'Claude Fable 5', vendor: 'by Anthropic', vendorKey: 'Anthropic', official: '$10.00', best: '$6.00', save: '40%', live: false, bestUsd: 6, officialUsd: 10},
  {model: 'Qwen3.7 Plus', vendor: 'by Qwen', vendorKey: 'Qwen', official: '$0.32', best: '$0.12', save: '64%', live: false, bestUsd: 0.12, officialUsd: 0.32},
  {model: 'MiniMax M3', vendor: 'by MiniMax', vendorKey: 'Minimax', official: '$0.30', best: '$0.09', save: '69%', live: false, bestUsd: 0.09, officialUsd: 0.3},
];

function normalizeService(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** "$0.45"; a $0 offer is "Free", sub-cent prices never round to "$0.00". */
function usd(n: number): string {
  if (n === 0) return 'Free';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

interface Candidate {
  row: ShowcaseRow;
  /** release date, unix seconds — primary rank */
  created: number;
  /** weekly OpenRouter tokens — noise floor + tie-break */
  popularity: number;
}

function buildCandidates(
  offerings: Offering[],
  models: OpenRouterModel[],
  popularity: PopularityMap,
): Candidate[] {
  // Proven, priced offerings grouped by normalized service id.
  const groups = new Map<string, ProvenOffering[]>();
  for (const o of offerings) {
    if (!isProven(o)) continue;
    const key = normalizeService(o.service);
    const group = groups.get(key);
    if (group) group.push(o);
    else groups.set(key, [o]);
  }

  // When the rankings feed is down the map is empty — skip the noise
  // floor rather than filtering everything out.
  const haveRankings = Object.keys(popularity).length > 0;

  const candidates: Candidate[] = [];
  for (const model of models) {
    const vendorPrefix = model.id.split('/', 1)[0];
    const vendorKey = VENDOR_KEYS[vendorPrefix];
    if (!vendorKey) continue;
    const group = groups.get(normalizeService(model.id.split('/')[1]));
    if (!group) continue;
    const weekly = popularity[model.canonicalSlug] ?? 0;
    if (haveRankings && weekly < MIN_WEEKLY_TOKENS) continue;
    const price = Math.min(...group.map(o => o.inputUsdPerMillion));
    if (price >= model.officialUsd) continue;
    const save =
      price === 0 ? 100 : Math.min(99, Math.max(1, Math.round((1 - price / model.officialUsd) * 100)));
    candidates.push({
      row: {
        model: model.name,
        vendor: `by ${model.vendorName}`,
        vendorKey,
        official: usd(model.officialUsd),
        best: usd(price),
        save: `${save}%`,
        live: true,
        bestUsd: price,
        officialUsd: model.officialUsd,
      },
      created: model.created,
      popularity: weekly,
    });
  }
  return candidates;
}

function pickShowcase(
  offerings: Offering[],
  models: OpenRouterModel[],
  popularity: PopularityMap,
  count: number,
): ShowcaseRow[] {
  const ranked = buildCandidates(offerings, models, popularity).sort(
    (a, b) => b.created - a.created || b.popularity - a.popularity,
  );
  if (ranked.length < count) return FALLBACK_ROWS;

  // Prefer vendor variety among the top picks, then fill by rank.
  const picked: Candidate[] = [];
  const seenVendors = new Set<string>();
  for (const c of ranked) {
    if (picked.length >= count) break;
    if (!seenVendors.has(c.row.vendorKey)) {
      picked.push(c);
      seenVendors.add(c.row.vendorKey);
    }
  }
  for (const c of ranked) {
    if (picked.length >= count) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.map(c => c.row);
}

interface CachedMarket {
  offerings: Offering[];
  models: OpenRouterModel[];
  popularity: PopularityMap;
}

function readCache(): CachedMarket | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {at: number} & CachedMarket;
    if (Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return {offerings: parsed.offerings, models: parsed.models, popularity: parsed.popularity ?? {}};
  } catch {
    return null;
  }
}

function writeCache(market: CachedMarket): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({at: Date.now(), ...market}));
  } catch {
    /* storage full / disabled — just refetch next navigation */
  }
}

interface RawOpenRouterModel {
  id: string;
  canonical_slug?: string;
  name?: string;
  created?: number;
  pricing?: {prompt?: string};
}

function slimOpenRouterModels(data: {data?: RawOpenRouterModel[]} | null): OpenRouterModel[] {
  const out: OpenRouterModel[] = [];
  for (const m of data?.data ?? []) {
    // ":free" / ":batch" variants aren't the official list price.
    if (!m.id || m.id.includes(':')) continue;
    const perToken = Number(m.pricing?.prompt);
    if (!Number.isFinite(perToken) || perToken <= 0) continue;
    // OpenRouter names read "Vendor: Model Name".
    const name = m.name ?? m.id;
    const sep = name.indexOf(': ');
    out.push({
      id: m.id,
      canonicalSlug: m.canonical_slug ?? m.id,
      name: sep > 0 ? name.slice(sep + 2) : name,
      vendorName: sep > 0 ? name.slice(0, sep) : m.id.split('/', 1)[0],
      officialUsd: perToken * 1e6,
      created: m.created ?? 0,
    });
  }
  return out;
}

interface RawRankingRow {
  model_permaslug?: string;
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
}

function slimRankings(data: {data?: RawRankingRow[]} | null): PopularityMap {
  const out: PopularityMap = {};
  for (const r of data?.data ?? []) {
    if (!r.model_permaslug) continue;
    out[r.model_permaslug] =
      (out[r.model_permaslug] ?? 0) + (r.total_prompt_tokens ?? 0) + (r.total_completion_tokens ?? 0);
  }
  return out;
}

async function fetchMarket(signal: AbortSignal): Promise<CachedMarket | null> {
  const [offerings, models, popularity] = await Promise.all([
    fetch(MARKETPLACE_API, {signal})
      .then(r => (r.ok ? r.json() : null))
      .then((data: {offerings?: Offering[]} | null) =>
        Array.isArray(data?.offerings)
          ? data.offerings.map(o => ({
              service: o.service,
              sellerAddress: o.sellerAddress,
              inputUsdPerMillion: o.inputUsdPerMillion,
              sellerOnChainReputationScore: o.sellerOnChainReputationScore,
            }))
          : null,
      ),
    fetch(OPENROUTER_MODELS_API, {signal})
      .then(r => (r.ok ? r.json() : null))
      .then(slimOpenRouterModels)
      .catch(() => [] as OpenRouterModel[]),
    // Unofficial endpoint — a failure just degrades ordering, so never fatal.
    fetch(OPENROUTER_RANKINGS_API, {signal})
      .then(r => (r.ok ? r.json() : null))
      .then(slimRankings)
      .catch(() => ({}) as PopularityMap),
  ]);
  if (!offerings || models.length === 0) return null;
  return {offerings, models, popularity};
}

/* One in-flight fetch shared by every mounted hook, so several cards on one
   page (the hero picks call useMarketplacePicks three times) hit the three
   APIs once. */
const subscribeMarketFetch = createSharedFetch(async signal => {
  const result = await fetchMarket(signal);
  if (result) writeCache(result);
  return result;
}, 8000);

/** Shared market fetch (session-cached) behind the showcase and pick hooks. */
function useMarket(): CachedMarket | null {
  const [market, setMarket] = useState<CachedMarket | null>(null);

  useEffect(() => {
    if (!ExecutionEnvironment.canUseDOM) return undefined;
    const cached = readCache();
    if (cached) {
      setMarket(cached);
      return undefined;
    }
    let cancelled = false;
    const {promise, unsubscribe} = subscribeMarketFetch();
    promise.then(result => {
      if (!cancelled && result) setMarket(result);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return market;
}

/** The pricing-card rows: live network picks, or the dated fallback snapshot. */
export function useMarketplaceShowcase(count = 4): ShowcaseRow[] {
  const market = useMarket();
  return market ? pickShowcase(market.offerings, market.models, market.popularity, count) : FALLBACK_ROWS;
}

export interface ModelPick {
  /** OpenRouter model id, e.g. "anthropic/claude-opus-5.5" */
  id: string;
  /** display name override (OpenRouter names carry date suffixes) */
  name: string;
  /** last verified live offer, used for SSR / API failure */
  fallback: {bestUsd: number; officialUsd: number};
}

/** Rows for a curated list of models (the hero's agent card): the lowest
    reputable live offer per model, in the given order; a model with no
    live offer shows its dated fallback snapshot. */
export function useMarketplacePicks(picks: ModelPick[]): ShowcaseRow[] {
  const market = useMarket();
  const byService = new Map<string, number>();
  if (market) {
    for (const o of market.offerings) {
      if (!isProven(o)) continue;
      const key = normalizeService(o.service);
      const prev = byService.get(key);
      if (prev === undefined || o.inputUsdPerMillion < prev) byService.set(key, o.inputUsdPerMillion);
    }
  }
  return picks.map(pick => {
    const [vendorPrefix, slug] = pick.id.split('/');
    const model = market?.models.find(m => m.id === pick.id);
    const live = byService.get(normalizeService(slug));
    const bestUsd = live ?? pick.fallback.bestUsd;
    const officialUsd = model?.officialUsd ?? pick.fallback.officialUsd;
    const save =
      bestUsd === 0 ? 100 : Math.min(99, Math.max(0, Math.round((1 - bestUsd / officialUsd) * 100)));
    return {
      model: pick.name,
      vendor: `by ${model?.vendorName ?? vendorPrefix}`,
      vendorKey: VENDOR_KEYS[vendorPrefix] ?? vendorPrefix,
      official: usd(officialUsd),
      best: usd(bestUsd),
      save: `${save}%`,
      live: live !== undefined,
      bestUsd,
      officialUsd,
    };
  });
}
