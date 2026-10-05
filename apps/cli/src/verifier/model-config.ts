import type {
  VerifierCLIConfig,
  VerifierContrastModelConfig,
  VerifierModelPricingConfig,
  VerifierReferenceEndpointConfig,
  VerifierReferenceModelConfig,
} from '../config/types.js'
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

export function configuredVerifierModels(config: VerifierCLIConfig | undefined): string[] {
  return Object.entries(config?.referenceEndpoint?.models ?? {})
    .filter(([, model]) => model.enabled !== false)
    .map(([service]) => service)
    .sort((left, right) => left.localeCompare(right))
}

export function excludedVerifierDomains(
  config: VerifierCLIConfig | undefined,
  requestedModel: string,
): ReadonlySet<string> {
  const endpoint = config?.referenceEndpoint
  const entry = endpoint && findModelEntry(endpoint, requestedModel)
  return new Set(entry?.[1].excludedDomains ?? [])
}

export function verifierModelServices(
  config: VerifierCLIConfig | undefined,
  requestedModel: string,
): string[] {
  const endpoint = config?.referenceEndpoint
  const entry = endpoint && findModelEntry(endpoint, requestedModel)
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
  if ((model.length > 0) === all) throw new Error('provide exactly one of <model> or --all')
  if (all) {
    const models = configuredVerifierModels(config)
    if (models.length === 0) throw new Error('no enabled verifier models are configured')
    return models
  }
  const endpoint = config?.referenceEndpoint
  const entry = endpoint && findModelEntry(endpoint, model)
  if (!entry) throw new Error(`verifier.referenceEndpoint.models has no mapping for ${model}`)
  if (entry[1].enabled === false) throw new Error(`verifier model ${entry[0]} is disabled`)
  return [entry[0]]
}

export function resolveVerifierModelConfig(
  config: VerifierCLIConfig | undefined,
  requestedModel: string,
  catalog: VerifierModelCatalog | null = null,
): ResolvedVerifierModelConfig {
  const endpoint = config?.referenceEndpoint
  if (!endpoint) throw new Error('verifier.referenceEndpoint is required')
  const entry = findModelEntry(endpoint, requestedModel)
  if (!entry) throw new Error(`verifier.referenceEndpoint.models has no mapping for ${requestedModel}`)
  const [service, model] = entry
  if (model.enabled === false) throw new Error(`verifier model ${service} is disabled`)
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
  return { ...model, service, pricing, contrastModels }
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
  const candidates: Array<{ name: string; candidate: VerifierContrastModelConfig }> = config.contrastSelection?.catalogSource === 'openrouter'
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
  if (config.contrastSelection?.catalogSource === 'openrouter') {
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

function findModelEntry(
  endpoint: VerifierReferenceEndpointConfig,
  requestedModel: string,
): [string, VerifierReferenceModelConfig] | undefined {
  return Object.entries(endpoint.models).find(([service]) => normalized(service) === normalized(requestedModel))
}
