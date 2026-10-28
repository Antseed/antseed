import type { TokenPricingUsdPerMillion } from '@antseed/node'
import type { VerifierCLIConfig, VerifierModelPricingConfig } from '../config/types.js'
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
  source: 'reference-route' | 'configured' | 'catalog'
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
 * Why the buyer's own price cap would refuse sellers the audit allows, or null when it doesn't.
 * Audit requests go through the local buyer, which refuses any seller above `buyer.maxPricing`.
 * If that cap is below a model's audit cap, sellers priced in between would fail mid-audit
 * instead of being audited, so the model is not audited until the buyer cap is raised.
 */
export function buyerCapShortfall(buyerMax: TokenPricingUsdPerMillion, cap: AuditPriceCap): string | null {
  const maxInput = cap.reference.inputUsdPerMillion * cap.ratio
  const maxOutput = cap.reference.outputUsdPerMillion * cap.ratio
  if (buyerMax.inputUsdPerMillion >= maxInput && buyerMax.outputUsdPerMillion >= maxOutput) return null
  const required = `${formatUsd(Math.max(buyerMax.inputUsdPerMillion, maxInput))}/${formatUsd(Math.max(buyerMax.outputUsdPerMillion, maxOutput))}`
  return `the buyer price cap (buyer.maxPricing.defaults) ${formatUsd(buyerMax.inputUsdPerMillion)}/${formatUsd(buyerMax.outputUsdPerMillion)} per 1M`
    + ` is below the ${cap.model} audit cap ${formatUsd(maxInput)}/${formatUsd(maxOutput)}, so the buyer would refuse sellers priced in between.`
    + ` Raise it to at least ${required} and restart the buyer`
}

/** `claude-fable-5.1 ≤ $10/$50 (OpenRouter)` for the run log. */
export function describeAuditPriceCap(cap: AuditPriceCap): string {
  const source = cap.source === 'catalog' ? 'reference catalog' : cap.source === 'configured' ? 'verifier.models pricing' : 'reference route'
  return `${cap.model} ≤ ${formatUsd(cap.reference.inputUsdPerMillion * cap.ratio)}/${formatUsd(cap.reference.outputUsdPerMillion * cap.ratio)} per 1M (${source})`
}

/** Up to 4 decimals; a sub-cent price keeps two significant digits so it never reads $0. */
function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`
  return `$${Math.round(value * 10_000) / 10_000}`
}

/**
 * Reference price caps for the models of a run. The catalog is fetched once, and only when a model
 * has no reference-route or configured price. A model with no price at all is reported in
 * `unpriced` (its sellers can't be audited) instead of failing the other models.
 */
export async function resolveAuditPriceCaps(
  config: VerifierCLIConfig | undefined,
  models: readonly string[],
  loadCatalog: () => Promise<VerifierModelCatalog>,
): Promise<{ caps: Map<string, AuditPriceCap>; unpriced: Map<string, string> }> {
  const caps = new Map<string, AuditPriceCap>()
  const unpriced = new Map<string, string>()
  let catalog: VerifierModelCatalog | null = null
  let catalogError: Error | null = null
  for (const model of models) {
    try {
      caps.set(model, resolveAuditPriceCap(config, model, null))
      continue
    } catch {
      // Needs the catalog.
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
