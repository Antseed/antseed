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
): Promise<VerifierModelCatalog> {
  const endpoint = config?.referenceEndpoint
  if (!endpoint) throw new Error('verifier.referenceEndpoint is required')
  const apiKey = (endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : undefined) ?? endpoint.apiKey
  const response = await fetchFn(`${endpoint.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  })
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  const parsed = await response.json() as { data?: unknown }
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
): Promise<VerifierModelPricingConfig | null> {
  const endpoint = config?.referenceEndpoint
  if (!endpoint) throw new Error('verifier.referenceEndpoint is required')
  const apiKey = (endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : undefined) ?? endpoint.apiKey
  const response = await fetchFn(`${endpoint.baseUrl.replace(/\/+$/, '')}/models/${upstreamModel}/endpoints`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`OpenRouter endpoints for ${upstreamModel} ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  const parsed = await response.json() as { data?: { endpoints?: unknown } }
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
