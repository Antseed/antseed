import type { VerifierCLIConfig, VerifierModelPricingConfig } from '../config/types.js'
import { usesOpenRouterCatalog } from './model-config.js'
import { normalized } from './utils.js'

export type VerifierReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface VerifierCatalogReasoning {
  mandatory: boolean
  supportedEfforts: VerifierReasoningEffort[] | null
}

export interface VerifierCatalogModel {
  upstreamModel: string
  pricing: VerifierModelPricingConfig
  capabilityRank: number | null
  reasoning?: VerifierCatalogReasoning
}

export type VerifierModelCatalog = ReadonlyMap<string, VerifierCatalogModel>

export async function loadConfiguredVerifierModelCatalog(
  config: VerifierCLIConfig | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<VerifierModelCatalog | null> {
  if (!usesOpenRouterCatalog(config)) return null
  return loadVerifierModelCatalog(config, fetchFn)
}

/**
 * The `referenceEndpoint`'s model catalog (OpenRouter `/models`) with per-million prices,
 * loaded whether or not contrast models come from it. Audits use it for reference prices.
 */
export async function loadVerifierModelCatalog(
  config: VerifierCLIConfig | undefined,
  fetchFn: typeof fetch = fetch,
  options: OpenRouterFetchOptions = {},
): Promise<VerifierModelCatalog> {
  const endpoint = config?.referenceEndpoint
  if (!endpoint) throw new Error('verifier.referenceEndpoint is required')
  const apiKey = (endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : undefined) ?? endpoint.apiKey
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/models`
  // Every model's reference build needs the catalog, and a run builds many models at once:
  // they share one download instead of each fetching the ~800 KB list. An injected fetch
  // (tests) always downloads.
  if (fetchFn !== globalThis.fetch) return parseCatalog(await fetchOpenRouterJson(url, 'OpenRouter model catalog', apiKey, fetchFn, options))
  const key = `${url}\n${apiKey ?? ''}`
  const cached = catalogCache.get(key)
  if (cached && Date.now() - cached.loadedAt < CATALOG_CACHE_MS) return cached.catalog
  const catalog = fetchOpenRouterJson(url, 'OpenRouter model catalog', apiKey, fetchFn, options).then(parseCatalog)
  catalogCache.set(key, { loadedAt: Date.now(), catalog })
  catalog.catch(() => {
    if (catalogCache.get(key)?.catalog === catalog) catalogCache.delete(key)
  })
  return catalog
}

/** How long one downloaded catalog is shared; a long run picks up new models and prices after this. */
export const CATALOG_CACHE_MS = 10 * 60 * 1000
const catalogCache = new Map<string, { loadedAt: number; catalog: Promise<VerifierModelCatalog> }>()

/** Downloads tried per OpenRouter catalog request before it fails. */
export const OPENROUTER_FETCH_ATTEMPTS = 3

export interface OpenRouterFetchOptions {
  /** Wait before retry n is n times this (default 1000 ms). */
  retryDelayMs?: number
}

/**
 * GETs an OpenRouter JSON document, retrying network errors, 429/5xx answers and bodies that are
 * not valid JSON. A long response can arrive cut off without any network error (Node's fetch
 * does not notice a compressed body that ends early), which would otherwise fail a whole model
 * build with a bare "SyntaxError … in JSON". Other HTTP errors are returned for the caller.
 */
async function fetchOpenRouterJson(
  url: string,
  label: string,
  apiKey: string | undefined,
  fetchFn: typeof fetch,
  options: OpenRouterFetchOptions,
  passStatuses: readonly number[] = [],
): Promise<{ status: number; body: unknown }> {
  let lastError = ''
  for (let attempt = 1; attempt <= OPENROUTER_FETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, (options.retryDelayMs ?? 1_000) * (attempt - 1)))
    let response: Response
    let text: string
    try {
      response = await fetchFn(url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined })
      text = await response.text()
    } catch (error) {
      lastError = `request failed: ${error instanceof Error ? error.message : String(error)}`
      continue
    }
    if (passStatuses.includes(response.status)) return { status: response.status, body: null }
    if (!response.ok) {
      lastError = `HTTP ${response.status}: ${text.slice(0, 200)}`
      if (response.status === 429 || response.status >= 500) continue
      throw new Error(`${label} (${url}) answered ${lastError}`)
    }
    try {
      return { status: response.status, body: JSON.parse(text) as unknown }
    } catch (error) {
      lastError = `the response (${text.length} bytes) was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  throw new Error(`${label} (${url}) failed after ${OPENROUTER_FETCH_ATTEMPTS} attempts; last: ${lastError}`)
}

function parseCatalog({ body }: { body: unknown }): VerifierModelCatalog {
  const parsed = (body ?? {}) as { data?: unknown }
  if (!Array.isArray(parsed.data)) throw new Error('OpenRouter model catalog response omitted data[]')
  const catalog = new Map<string, VerifierCatalogModel>()
  for (const raw of parsed.data) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const model = raw as Record<string, unknown>
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (!id) continue
    const pricing = parsePricing(model.pricing)
    if (!pricing) continue
    const reasoning = parseReasoning(model.reasoning)
    catalog.set(normalized(id), {
      upstreamModel: id,
      pricing,
      capabilityRank: parseIntelligenceIndex(model.benchmarks),
      ...(reasoning ? { reasoning } : {}),
    })
  }
  if (catalog.size === 0) throw new Error('OpenRouter model catalog contained no priced models')
  return catalog
}

/** Drops the shared catalog download (tests). */
export function clearVerifierModelCatalogCache(): void {
  catalogCache.clear()
}

/** OpenRouter endpoint tag parts for paid speed tiers of the same model (`openai/ultrafast`, `baseten/us/fast`). */
const SPEED_TIER_TAG_PARTS = new Set(['fast', 'ultrafast', 'flex'])

/** True when an endpoint tag names a speed tier rather than a standard deployment. */
export function isSpeedTierEndpoint(tag: unknown): boolean {
  if (typeof tag !== 'string') return false
  return tag.toLowerCase().split('/').slice(1).some((part) => SPEED_TIER_TAG_PARTS.has(part))
}

/**
 * The highest price any OpenRouter provider charges for `upstreamModel` (`/models/<id>/endpoints`),
 * input and output each at their maximum, or null when the model lists no priced endpoint.
 * Speed tiers (`fast`, `ultrafast`, `flex` tags) are skipped: they are the same model at a
 * different speed, and an `ultrafast` tier can cost 6x the standard price.
 */
export async function loadHighestEndpointPrice(
  config: VerifierCLIConfig | undefined,
  upstreamModel: string,
  fetchFn: typeof fetch = fetch,
  options: OpenRouterFetchOptions = {},
): Promise<VerifierModelPricingConfig | null> {
  const endpoint = config?.referenceEndpoint
  if (!endpoint) throw new Error('verifier.referenceEndpoint is required')
  const apiKey = (endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : undefined) ?? endpoint.apiKey
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/models/${upstreamModel}/endpoints`
  const { status, body } = await fetchOpenRouterJson(url, `OpenRouter endpoints for ${upstreamModel}`, apiKey, fetchFn, options, [404])
  if (status === 404) return null
  const parsed = (body ?? {}) as { data?: { endpoints?: unknown } }
  const endpoints = Array.isArray(parsed.data?.endpoints) ? parsed.data.endpoints : []
  let highest: VerifierModelPricingConfig | null = null
  for (const raw of endpoints) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    if (isSpeedTierEndpoint((raw as Record<string, unknown>).tag)) continue
    const pricing = parsePricing((raw as Record<string, unknown>).pricing)
    if (!pricing) continue
    highest = highest
      ? {
          inputUsdPerMillion: Math.max(highest.inputUsdPerMillion, pricing.inputUsdPerMillion),
          outputUsdPerMillion: Math.max(highest.outputUsdPerMillion, pricing.outputUsdPerMillion),
        }
      : pricing
  }
  return highest
}

function parsePricing(value: unknown): VerifierModelPricingConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const pricing = value as Record<string, unknown>
  const inputUsdPerToken = parseNonNegativeNumber(pricing.prompt)
  const outputUsdPerToken = parseNonNegativeNumber(pricing.completion)
  if (inputUsdPerToken === null || outputUsdPerToken === null) return null
  return {
    inputUsdPerMillion: inputUsdPerToken * 1_000_000,
    outputUsdPerMillion: outputUsdPerToken * 1_000_000,
  }
}

function parseIntelligenceIndex(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const artificialAnalysis = (value as Record<string, unknown>).artificial_analysis
  if (!artificialAnalysis || typeof artificialAnalysis !== 'object' || Array.isArray(artificialAnalysis)) return null
  return parseNonNegativeNumber((artificialAnalysis as Record<string, unknown>).intelligence_index)
}

function parseReasoning(value: unknown): VerifierCatalogReasoning | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const reasoning = value as Record<string, unknown>
  const mandatory = reasoning.mandatory === true
  const rawEfforts = reasoning.supported_efforts
  if (rawEfforts !== null && !Array.isArray(rawEfforts)) return mandatory ? { mandatory, supportedEfforts: null } : null
  const supportedEfforts = rawEfforts === null
    ? null
    : rawEfforts.filter(isReasoningEffort)
  return { mandatory, supportedEfforts }
}

function isReasoningEffort(value: unknown): value is VerifierReasoningEffort {
  return typeof value === 'string'
    && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)
}

function parseNonNegativeNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
