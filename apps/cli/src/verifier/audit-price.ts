import type { TokenPricingUsdPerMillion } from '@antseed/node'
import type { VerifierCLIConfig, VerifierModelPricingConfig } from '../config/types.js'
import { mapConcurrently } from './audit-concurrency.js'
import { findVerifierModel, withAntseedUpstreamRoute } from './model-config.js'
import type { VerifierModelCatalog } from './openrouter-catalog.js'
import { normalized } from './utils.js'

export const DEFAULT_AUDIT_PRICE_RATIO = 1

/**
 * The most a seller may charge for an audited model and still be audited: the genuine model's
 * reference price times `verifier.auditPriceRatio`. A seller priced above it is skipped
 * (`price_above_reference`) before any request is sent.
 */
export interface AuditPriceCap {
  /** Built-in audited model key, e.g. `claude-fable-5.1`. */
  model: string
  /** The genuine model's price, USD per 1M tokens. */
  reference: VerifierModelPricingConfig
  /** Where `reference` came from. */
  source: 'reference-route' | 'configured' | 'catalog' | 'highest-provider'
  /** `verifier.auditPriceRatio` (1 = the reference price itself). */
  ratio: number
}

/**
 * The reference price of an audited model, in the same order reference builds price it: the
 * reference route's or upstream's pricing (what that source charges), then `verifier.models.<model>.pricing`,
 * then the reference endpoint's catalog (OpenRouter). Throws when none is available, since the
 * model can't be audited without one.
 */
export function resolveAuditPriceCap(
  config: VerifierCLIConfig | undefined,
  model: string,
  catalog: VerifierModelCatalog | null,
): AuditPriceCap {
  const entry = findVerifierModel(config, model)
  if (!entry || !config) throw new Error(`${model} is not an audited model`)
  const [service, settings] = entry
  const ratio = config.auditPriceRatio ?? DEFAULT_AUDIT_PRICE_RATIO
  const routed = withAntseedUpstreamRoute(config, settings).referenceRoute?.pricing ?? settings.upstream?.pricing
  if (routed) return { model: service, reference: routed, source: 'reference-route', ratio }
  if (settings.pricing) return { model: service, reference: settings.pricing, source: 'configured', ratio }
  const listed = catalog?.get(normalized(settings.upstreamModel))?.pricing
  if (listed) return { model: service, reference: listed, source: 'catalog', ratio }
  throw new Error(
    `no reference price for ${service}: ${settings.upstreamModel} is not priced in the reference endpoint's catalog`
    + ' and verifier.models has no pricing for it, so its sellers cannot be audited',
  )
}

/** Why a seller's advertised price is above the audit cap, or null when it may be audited. */
export function auditPriceRejection(offer: TokenPricingUsdPerMillion, cap: AuditPriceCap): string | null {
  const maxInput = cap.reference.inputUsdPerMillion * cap.ratio
  const maxOutput = cap.reference.outputUsdPerMillion * cap.ratio
  const reference = `the ${cap.model} reference ${formatUsd(cap.reference.inputUsdPerMillion)}/${formatUsd(cap.reference.outputUsdPerMillion)}`
    + (cap.ratio === 1 ? '' : ` × ${cap.ratio}`)
  if (offer.inputUsdPerMillion > maxInput || offer.outputUsdPerMillion > maxOutput) {
    return `priced ${formatUsd(offer.inputUsdPerMillion)}/${formatUsd(offer.outputUsdPerMillion)} per 1M, above ${reference} · not audited`
  }
  if (offer.cachedInputUsdPerMillion != null && offer.cachedInputUsdPerMillion > maxInput) {
    return `cached input priced ${formatUsd(offer.cachedInputUsdPerMillion)} per 1M, above ${reference} input price · not audited`
  }
  return null
}

/**
 * Why the running buyer's price cap would refuse sellers the audit allows, or null when it doesn't.
 * Audit requests go through the local buyer, which refuses any seller above its `buyer.maxPricing`.
 * The buyer's caps only need to be at or above the model's audit cap; they don't have to match.
 * Cached input is audited up to the input cap, and the buyer caps it at its cached-input cap
 * (its input cap when none is set).
 */
export function buyerCapShortfall(buyerMax: TokenPricingUsdPerMillion, cap: AuditPriceCap): string | null {
  const maxInput = cap.reference.inputUsdPerMillion * cap.ratio
  const maxOutput = cap.reference.outputUsdPerMillion * cap.ratio
  const buyerCached = buyerMax.cachedInputUsdPerMillion ?? buyerMax.inputUsdPerMillion
  const short: string[] = []
  if (buyerMax.inputUsdPerMillion < maxInput) short.push(`input ${formatUsd(buyerMax.inputUsdPerMillion)} < ${formatUsd(maxInput)}`)
  if (buyerMax.outputUsdPerMillion < maxOutput) short.push(`output ${formatUsd(buyerMax.outputUsdPerMillion)} < ${formatUsd(maxOutput)}`)
  if (buyerCached < maxInput) short.push(`cached input ${formatUsd(buyerCached)} < ${formatUsd(maxInput)}`)
  if (short.length === 0) return null
  return `${cap.model}: the buyer price cap is below its reference price (${short.join(', ')} per 1M)`
}

/** The lowest buyer cap that covers every given audit cap, formatted for the run error. */
export function requiredBuyerCap(caps: readonly AuditPriceCap[]): { input: string; output: string } {
  const input = Math.max(0, ...caps.map((cap) => cap.reference.inputUsdPerMillion * cap.ratio))
  const output = Math.max(0, ...caps.map((cap) => cap.reference.outputUsdPerMillion * cap.ratio))
  return { input: formatUsd(input), output: formatUsd(output) }
}

/** `claude-fable-5.1 ≤ $10/$50 (OpenRouter)` for the run log. */
export function describeAuditPriceCap(cap: AuditPriceCap): string {
  const source = cap.source === 'catalog' ? 'reference catalog'
    : cap.source === 'configured' ? 'verifier.models pricing'
      : cap.source === 'highest-provider' ? 'highest OpenRouter provider' : 'reference route'
  return `${cap.model} ≤ ${formatUsd(cap.reference.inputUsdPerMillion * cap.ratio)}/${formatUsd(cap.reference.outputUsdPerMillion * cap.ratio)} per 1M (${source})`
}

/** Up to 4 decimals; a sub-cent price keeps two significant digits so it never reads $0. */
function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`
  return `$${Math.round(value * 10_000) / 10_000}`
}

const HIGHEST_PRICE_LOOKUPS = 4

/**
 * Reference price caps for the models of a run. Each model's cap is the highest price any reference
 * provider charges for it (`loadHighestPrice`, OpenRouter's per-model endpoints), input and output
 * each at their maximum, unless the reference route or configured price is higher. Without a
 * highest price (not listed, or the lookup failed), the reference route, configured price, then the
 * catalog listing are used. The catalog is fetched at most once, and only when needed. A model with
 * no price at all is reported in `unpriced` (its sellers can't be audited) instead of failing the
 * other models.
 */
export async function resolveAuditPriceCaps(
  config: VerifierCLIConfig | undefined,
  models: readonly string[],
  loadCatalog: () => Promise<VerifierModelCatalog>,
  loadHighestPrice?: (upstreamModel: string) => Promise<VerifierModelPricingConfig | null>,
): Promise<{ caps: Map<string, AuditPriceCap>; unpriced: Map<string, string> }> {
  const caps = new Map<string, AuditPriceCap>()
  const unpriced = new Map<string, string>()
  let catalog: VerifierModelCatalog | null = null
  let catalogError: Error | null = null
  // Independent lookups, so they run side by side; a failed one falls back to the sources below.
  const highestPrices = await mapConcurrently(models, HIGHEST_PRICE_LOOKUPS, async (model) => {
    const entry = findVerifierModel(config, model)
    if (!entry || !loadHighestPrice) return null
    try {
      return await loadHighestPrice(entry[1].upstreamModel)
    } catch {
      return null
    }
  })
  for (const [index, model] of models.entries()) {
    const highest = highestPrices[index] ?? null
    let base: AuditPriceCap | null = null
    try {
      base = resolveAuditPriceCap(config, model, null)
    } catch {
      // Needs the catalog, unless the highest provider price covers it.
    }
    if (base || highest) {
      caps.set(model, withHighestPrice(config, model, base, highest))
      continue
    }
    if (!catalog && !catalogError) {
      try {
        catalog = await loadCatalog()
      } catch (error) {
        catalogError = error instanceof Error ? error : new Error(String(error))
      }
    }
    if (catalogError) {
      unpriced.set(model, `no reference price for ${model}: loading the reference catalog failed: ${catalogError.message}`)
      continue
    }
    try {
      caps.set(model, resolveAuditPriceCap(config, model, catalog))
    } catch (error) {
      unpriced.set(model, error instanceof Error ? error.message : String(error))
    }
  }
  return { caps, unpriced }
}

/** The base cap raised to the highest provider price, or the highest price alone. */
function withHighestPrice(
  config: VerifierCLIConfig | undefined,
  model: string,
  base: AuditPriceCap | null,
  highest: VerifierModelPricingConfig | null,
): AuditPriceCap {
  if (!highest) return base!
  if (!base) {
    const [service] = findVerifierModel(config, model)!
    return { model: service, reference: highest, source: 'highest-provider', ratio: config?.auditPriceRatio ?? DEFAULT_AUDIT_PRICE_RATIO }
  }
  const input = Math.max(base.reference.inputUsdPerMillion, highest.inputUsdPerMillion)
  const output = Math.max(base.reference.outputUsdPerMillion, highest.outputUsdPerMillion)
  if (input === base.reference.inputUsdPerMillion && output === base.reference.outputUsdPerMillion) return base
  return { ...base, reference: { inputUsdPerMillion: input, outputUsdPerMillion: output }, source: 'highest-provider' }
}
