import type {
  VerifierCLIConfig,
  VerifierContrastModelConfig,
  VerifierModelPricingConfig,
  VerifierReferenceModelConfig,
} from '../config/types.js'
import { auditedModels, findAuditedModelKey } from './audited-models.js'
import type { VerifierModelCatalog } from './openrouter-catalog.js'
import { normalized } from './utils.js'

export const DEFAULT_CONTRAST_INPUT_WEIGHT = 0.9
export const DEFAULT_CONTRAST_MAX_PRICE_RATIO = 0.3
export const DEFAULT_CONTRAST_MAX_MODELS = 3

export interface ResolvedVerifierModelConfig extends Omit<VerifierReferenceModelConfig, 'pricing'> {
  service: string
  pricing?: VerifierModelPricingConfig
  contrastModels: string[]
}

/**
 * Every built-in audited model merged with the verifier's own settings for it
 * (`verifier.models.<model>`), sorted by service name. The model list and each model's reference id
 * come from `audited-models.ts`; a config cannot add models.
 */
export function auditedVerifierModels(
  config: VerifierCLIConfig | undefined,
): Array<[string, VerifierReferenceModelConfig]> {
  const settings = new Map(Object.entries(config?.models ?? {})
    .map(([service, value]) => [findAuditedModelKey(service) ?? service, value] as const))
  return Object.entries(auditedModels())
    .map(([service, model]): [string, VerifierReferenceModelConfig] => [service, {
      ...withoutRemovedSettings(settings.get(service)),
      upstreamModel: model.upstreamModel,
      ...(model.serviceAliases?.length ? { serviceAliases: [...model.serviceAliases] } : {}),
    }])
    .sort(([left], [right]) => left.localeCompare(right))
}

function withoutRemovedSettings<T extends { enabled?: unknown }>(value: T | undefined): Omit<T, 'enabled'> | undefined {
  if (!value) return undefined
  const { enabled: _removed, ...rest } = value
  return rest
}

/** Every built-in audited model. Auditors can't turn models off: the assignment depends only on the auditor and the epoch. */
export function configuredVerifierModels(config: VerifierCLIConfig | undefined): string[] {
  return auditedVerifierModels(config).map(([service]) => service)
}

/** True when contrast models are chosen from the OpenRouter catalog: the default unless a manual contrastModelBank is configured. */
export function usesOpenRouterCatalog(config: VerifierCLIConfig | undefined): boolean {
  return config?.contrastSelection?.catalogSource === 'openrouter'
    || (config?.contrastSelection?.catalogSource === undefined && config?.referenceEndpoint?.contrastModelBank === undefined)
}

export function findVerifierModel(
  config: VerifierCLIConfig | undefined,
  requestedModel: string,
): [string, VerifierReferenceModelConfig] | undefined {
  const wanted = normalized(requestedModel)
  return auditedVerifierModels(config).find(([service, model]) => [service, ...(model.serviceAliases ?? [])]
    .some((name) => normalized(name) === wanted))
}

export function excludedVerifierDomains(
  config: VerifierCLIConfig | undefined,
  requestedModel: string,
): ReadonlySet<string> {
  return new Set(findVerifierModel(config, requestedModel)?.[1].excludedDomains ?? [])
}

export function verifierModelServices(
  config: VerifierCLIConfig | undefined,
  requestedModel: string,
): string[] {
  const entry = findVerifierModel(config, requestedModel)
  if (!entry) return [requestedModel.trim().toLowerCase()]
  return [entry[0], ...(entry[1].serviceAliases ?? [])]
    .map((service) => service.trim().toLowerCase())
    .filter((service, index, services) => service.length > 0 && services.indexOf(service) === index)
}

export function resolveVerifierCommandModels(
  config: VerifierCLIConfig | undefined,
  modelValue: string | undefined,
  all: boolean,
): string[] {
  const model = modelValue?.trim() ?? ''
  if ((model.length > 0) === all) throw new Error('provide exactly one of <model>, --all, or --auditor <address>')
  if (all) {
    return configuredVerifierModels(config)
  }
  const entry = findVerifierModel(config, model)
  if (!entry) throw new Error(`${model} is not an audited model`)
  return [entry[0]]
}

export function resolveVerifierModelConfig(
  config: VerifierCLIConfig | undefined,
  requestedModel: string,
  catalog: VerifierModelCatalog | null = null,
): ResolvedVerifierModelConfig {
  if (!config?.referenceEndpoint) throw new Error('verifier.referenceEndpoint is required')
  const entry = findVerifierModel(config, requestedModel)
  if (!entry) throw new Error(`${requestedModel} is not an audited model`)
  const [service, model] = entry
  const maximum = config?.contrastSelection?.maxModels ?? DEFAULT_CONTRAST_MAX_MODELS
  const explicit = model.contrastModels?.map((value) => value.trim()).filter(Boolean)
  if (explicit && explicit.length > maximum) {
    throw new Error(`verifier model ${service} has more than ${maximum} explicit contrast models`)
  }
  const pricing = explicit?.length ? model.pricing : resolveTargetPricing(config, service, model, catalog)
  const contrastModels = explicit?.length ? explicit : selectAutomaticContrastModels(config, model, pricing!, catalog)
  if (contrastModels.length === 0) {
    throw new Error(
      `no contrast models selected for ${service}; check the configured price ratio and intelligence threshold`,
    )
  }
  return { ...withAntseedUpstreamRoute(config, model), service, pricing, contrastModels }
}

/**
 * An `antseed` entry in `verifier.upstreams` is the same as a per-model `referenceRoute`:
 * reference requests go through the buyer proxy, pinned to that seller.
 */
export function withAntseedUpstreamRoute(
  config: VerifierCLIConfig,
  model: VerifierReferenceModelConfig,
): VerifierReferenceModelConfig {
  const upstream = model.upstream && config.upstreams?.[model.upstream.name]
  if (upstream?.type !== 'antseed') return model
  if (!model.upstream!.pricing) throw new Error(`upstream ${model.upstream!.name} requires upstream.pricing`)
  const selected = model.upstream
  return {
    ...model,
    referenceRoute: {
      type: 'antseed',
      service: (selected!.model ?? model.upstreamModel).trim(),
      peerId: upstream.peerId,
      pricing: selected!.pricing!,
    },
  }
}

export function blendedModelPrice(
  pricing: VerifierModelPricingConfig,
  inputWeight: number = DEFAULT_CONTRAST_INPUT_WEIGHT,
): number {
  return pricing.inputUsdPerMillion * inputWeight
    + pricing.outputUsdPerMillion * (1 - inputWeight)
}

function selectAutomaticContrastModels(
  config: VerifierCLIConfig,
  model: VerifierReferenceModelConfig,
  pricing: VerifierModelPricingConfig,
  catalog: VerifierModelCatalog | null,
): string[] {
  const endpoint = config.referenceEndpoint!
  const inputWeight = config.contrastSelection?.inputWeight ?? DEFAULT_CONTRAST_INPUT_WEIGHT
  const maxPriceRatio = config.contrastSelection?.maxPriceRatio ?? DEFAULT_CONTRAST_MAX_PRICE_RATIO
  const maximum = config.contrastSelection?.maxModels ?? DEFAULT_CONTRAST_MAX_MODELS
  const minimumIntelligenceIndex = config.contrastSelection?.minimumIntelligenceIndex ?? 0
  const targetPrice = blendedModelPrice(pricing, inputWeight)
  const candidates: Array<{ name: string; candidate: VerifierContrastModelConfig }> = usesOpenRouterCatalog(config)
    ? [...requireCatalog(catalog).values()].flatMap((candidate) => candidate.capabilityRank === null ? [] : [{
      name: candidate.upstreamModel,
      candidate: {
        upstreamModel: candidate.upstreamModel,
        pricing: candidate.pricing,
        capabilityRank: candidate.capabilityRank,
      },
    }])
    : Object.entries(endpoint.contrastModelBank ?? {}).map(([name, candidate]) => ({ name, candidate }))
  return candidates
    .filter(({ candidate }) => candidate.enabled !== false)
    .filter(({ candidate }) => !normalized(candidate.upstreamModel).endsWith(':batch'))
    .filter(({ candidate }) => normalized(candidate.upstreamModel) !== normalized(model.upstreamModel))
    .filter(({ candidate }) => candidate.capabilityRank >= minimumIntelligenceIndex)
    .map(({ name, candidate }) => ({
      name,
      candidate,
      blendedPrice: blendedModelPrice(candidate.pricing, inputWeight),
    }))
    .filter(({ blendedPrice }) => blendedPrice <= targetPrice * maxPriceRatio)
    .sort((left, right) => right.candidate.capabilityRank - left.candidate.capabilityRank
      || left.blendedPrice - right.blendedPrice
      || left.name.localeCompare(right.name))
    .slice(0, maximum)
    .map(({ candidate }) => candidate.upstreamModel)
}

function resolveTargetPricing(
  config: VerifierCLIConfig,
  service: string,
  model: VerifierReferenceModelConfig,
  catalog: VerifierModelCatalog | null,
): VerifierModelPricingConfig {
  if (usesOpenRouterCatalog(config)) {
    const catalogModel = requireCatalog(catalog).get(normalized(model.upstreamModel))
    if (!catalogModel) throw new Error(`OpenRouter catalog has no priced model ${model.upstreamModel} for ${service}`)
    return catalogModel.pricing
  }
  if (!model.pricing) throw new Error(`verifier model ${service} requires pricing for automatic contrast selection`)
  return model.pricing
}

function requireCatalog(catalog: VerifierModelCatalog | null): VerifierModelCatalog {
  if (!catalog) throw new Error('OpenRouter model catalog must be loaded before resolving verifier models')
  return catalog
}
