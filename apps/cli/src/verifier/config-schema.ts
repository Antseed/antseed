import { z } from 'zod'
import {
  CANONICAL_KBF_DOMAINS,
  type CanonicalKbfDomainKey,
} from './canonical-kbf-domains.js'

const PEER_ID_PATTERN = /^[0-9a-fA-F]{40}$/
const canonicalDomainKeys = new Set<string>(CANONICAL_KBF_DOMAINS.map((domain) => domain.key))

const nonEmptyStringSchema = z.string().trim().min(1, 'must be a non-empty string')
const positiveIntegerSchema = z.number().int().min(1, 'must be an integer >= 1')
const probeCountSchema = z.number().int()
  .min(10, 'must be a multiple of 10 from 10 through 500')
  .max(500, 'must be a multiple of 10 from 10 through 500')
  .multipleOf(10, 'must be a multiple of 10 from 10 through 500')

const canonicalDomainSchema = z.custom<CanonicalKbfDomainKey>(
  (value) => typeof value === 'string' && canonicalDomainKeys.has(value),
  'must be a canonical KBF domain',
)

function strictObject<T extends z.ZodRawShape>(shape: T): z.ZodObject<T> {
  return z.object(shape).strict()
}

function uniqueStringsSchema(invalidMessage: string, duplicateMessage: string) {
  return z.array(z.unknown()).superRefine((values, context) => {
    if (values.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
      context.addIssue({ code: 'custom', message: invalidMessage })
      return
    }
    const normalized = values.map((value) => (value as string).trim().toLowerCase())
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({ code: 'custom', message: duplicateMessage })
    }
  }).transform((values) => values as string[])
}

export const VerifierModelPricingSchema = strictObject({
  inputUsdPerMillion: z.number().finite().min(0, 'must be a finite number >= 0'),
  outputUsdPerMillion: z.number().finite().min(0, 'must be a finite number >= 0'),
})

export const VerifierAntseedReferenceRouteSchema = strictObject({
  type: z.literal('antseed'),
  service: nonEmptyStringSchema,
  peerId: z.string().regex(PEER_ID_PATTERN, 'must be a 40-character hex peer id'),
  pricing: VerifierModelPricingSchema,
})

export const VerifierReferenceModelSchema = strictObject({
  enabled: z.boolean().optional(),
  serviceAliases: uniqueStringsSchema(
    'must be a string array when provided',
    'must not duplicate the model service or another alias',
  ).optional(),
  upstreamModel: nonEmptyStringSchema,
  pricing: VerifierModelPricingSchema.optional(),
  referenceRoute: VerifierAntseedReferenceRouteSchema.optional(),
  contrastModels: uniqueStringsSchema(
    'must be a string array when provided',
    'must not contain duplicates',
  ).optional(),
  excludedDomains: z.array(canonicalDomainSchema).superRefine((domains, context) => {
    if (new Set(domains).size !== domains.length) {
      context.addIssue({ code: 'custom', message: 'must not contain duplicates' })
    }
    if (domains.length >= CANONICAL_KBF_DOMAINS.length) {
      context.addIssue({ code: 'custom', message: 'must leave at least one canonical KBF domain enabled' })
    }
  }).optional(),
})

export const VerifierContrastModelSchema = strictObject({
  enabled: z.boolean().optional(),
  upstreamModel: nonEmptyStringSchema,
  pricing: VerifierModelPricingSchema,
  capabilityRank: z.number().finite().min(0, 'must be a finite number >= 0'),
})

export const VerifierContrastSelectionSchema = strictObject({
  catalogSource: z.literal('openrouter').optional(),
  inputWeight: z.number().finite().min(0).max(1).optional(),
  maxPriceRatio: z.number().finite().positive().max(1).optional(),
  maxModels: z.number().int().min(1).max(3).optional(),
  minimumIntelligenceIndex: z.number().finite().min(0).optional(),
})

const verifierModelsSchema = z.record(z.string(), VerifierReferenceModelSchema)
  .refine((models) => Object.keys(models).length > 0, 'must not be empty')

const contrastModelBankSchema = z.record(z.string(), VerifierContrastModelSchema)
  .refine((models) => Object.keys(models).length > 0, 'must not be empty')

export const VerifierReferenceEndpointSchema = strictObject({
  baseUrl: nonEmptyStringSchema,
  apiKey: z.string().optional(),
  apiKeyEnv: nonEmptyStringSchema.optional(),
  sourceId: nonEmptyStringSchema,
  trust: z.enum(['smoke', 'trusted']),
  antseedPeerId: z.string().regex(PEER_ID_PATTERN, 'must be a 40-character hex peer id').optional(),
  models: verifierModelsSchema,
  contrastModelBank: contrastModelBankSchema.optional(),
})

export const VerifierConfigSchema = strictObject({
  referencesDir: nonEmptyStringSchema.optional(),
  banksDir: nonEmptyStringSchema.optional(),
  evidenceDir: nonEmptyStringSchema.optional(),
  probeRequestTimeoutMs: positiveIntegerSchema.optional(),
  responseAuthWaitTimeoutMs: positiveIntegerSchema.optional(),
  auditMaxConcurrentModels: positiveIntegerSchema.optional(),
  auditMaxConcurrentPeersPerModel: positiveIntegerSchema.optional(),
  auditMaxConcurrentBatches: positiveIntegerSchema.optional(),
  auditMaxConcurrentBatchesPerPeer: positiveIntegerSchema.optional(),
  auditConcurrencyPromotionLatencyMs: positiveIntegerSchema.optional(),
  auditPeerTimeoutMs: positiveIntegerSchema.optional(),
  contrastSelection: VerifierContrastSelectionSchema.optional(),
  referenceEndpoint: VerifierReferenceEndpointSchema.optional(),
  referenceMaxRequestsPerBuild: positiveIntegerSchema.optional(),
  referenceBatchRetryCount: z.number().int().min(0, 'must be an integer >= 0').optional(),
  referenceRetryBaseDelayMs: positiveIntegerSchema.optional(),
  referenceMaxNoProgressRounds: positiveIntegerSchema.optional(),
  referenceMaxConcurrentRequests: positiveIntegerSchema.optional(),
  referenceMaxConcurrentRequestsPerModel: positiveIntegerSchema.optional(),
  referenceMinimumProbeCount: probeCountSchema.optional(),
  referenceMaximumProbeCount: probeCountSchema.optional(),
  referenceProbeStep: probeCountSchema.optional(),
  referenceMinimumStatisticalPower: z.number().finite().positive().max(1).optional(),
}).superRefine((config, context) => {
  const minimumProbeCount = config.referenceMinimumProbeCount ?? 100
  const maximumProbeCount = config.referenceMaximumProbeCount ?? 500
  const probeStep = config.referenceProbeStep ?? 10
  if (minimumProbeCount > maximumProbeCount) {
    context.addIssue({
      code: 'custom',
      path: ['referenceMinimumProbeCount'],
      message: 'must not exceed referenceMaximumProbeCount',
    })
  } else if ((maximumProbeCount - minimumProbeCount) % probeStep !== 0) {
    context.addIssue({
      code: 'custom',
      path: ['referenceProbeStep'],
      message: 'must divide the configured probe-count range',
    })
  }

  const endpoint = config.referenceEndpoint
  if (!endpoint) return

  const usesOpenRouterCatalog = config.contrastSelection?.catalogSource === 'openrouter'
  const maxContrastModels = config.contrastSelection?.maxModels ?? 3
  if (usesOpenRouterCatalog && endpoint.contrastModelBank !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['referenceEndpoint', 'contrastModelBank'],
      message: 'must be omitted when contrastSelection.catalogSource is "openrouter"',
    })
  }

  let requiresAutomaticSelection = false
  for (const [service, model] of Object.entries(endpoint.models)) {
    const modelPath = ['referenceEndpoint', 'models', service] as const
    if (model.serviceAliases) {
      const normalizedServices = [service, ...model.serviceAliases].map((value) => value.trim().toLowerCase())
      if (new Set(normalizedServices).size !== normalizedServices.length) {
        context.addIssue({
          code: 'custom',
          path: [...modelPath, 'serviceAliases'],
          message: 'must not duplicate the model service or another alias',
        })
      }
    }

    const hasExplicitContrasts = (model.contrastModels?.length ?? 0) > 0
    if ((model.contrastModels?.length ?? 0) > maxContrastModels) {
      context.addIssue({
        code: 'custom',
        path: [...modelPath, 'contrastModels'],
        message: `must contain at most ${maxContrastModels} entries`,
      })
    }
    if (usesOpenRouterCatalog && model.pricing !== undefined) {
      context.addIssue({
        code: 'custom',
        path: [...modelPath, 'pricing'],
        message: 'must be omitted when contrastSelection.catalogSource is "openrouter"',
      })
    } else if (!usesOpenRouterCatalog && !hasExplicitContrasts && model.enabled !== false && model.pricing === undefined) {
      context.addIssue({
        code: 'custom',
        path: [...modelPath, 'pricing'],
        message: 'is required for automatic contrast-model selection',
      })
    }
    if (model.enabled !== false && !hasExplicitContrasts) requiresAutomaticSelection = true
  }

  if (!usesOpenRouterCatalog && requiresAutomaticSelection && endpoint.contrastModelBank === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['referenceEndpoint', 'contrastModelBank'],
      message: 'is required when an enabled model has no explicit contrastModels',
    })
  }
})

export type VerifierCLIConfig = z.infer<typeof VerifierConfigSchema>
export type VerifierContrastSelectionConfig = z.infer<typeof VerifierContrastSelectionSchema>
export type VerifierModelPricingConfig = z.infer<typeof VerifierModelPricingSchema>
export type VerifierAntseedReferenceRouteConfig = z.infer<typeof VerifierAntseedReferenceRouteSchema>
export type VerifierReferenceModelConfig = z.infer<typeof VerifierReferenceModelSchema>
export type VerifierContrastModelConfig = z.infer<typeof VerifierContrastModelSchema>
export type VerifierReferenceEndpointConfig = z.infer<typeof VerifierReferenceEndpointSchema>

function formatConfigPath(rootPath: string, issuePath: PropertyKey[]): string {
  let formatted = rootPath
  for (const segment of issuePath) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`
    } else if (typeof segment === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      formatted += `.${segment}`
    } else {
      formatted += `[${JSON.stringify(String(segment))}]`
    }
  }
  return formatted
}

export function appendVerifierConfigErrors(
  rootPath: string,
  value: unknown,
  errors: string[],
): void {
  if (value === undefined) return
  const result = VerifierConfigSchema.safeParse(value)
  if (result.success) return

  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        errors.push(`${formatConfigPath(rootPath, [...issue.path, key])} is not supported`)
      }
      continue
    }
    errors.push(`${formatConfigPath(rootPath, issue.path)} ${issue.message}`)
  }
}
