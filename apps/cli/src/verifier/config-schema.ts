import { z } from 'zod'
import {
  CANONICAL_KBF_DOMAINS,
  type CanonicalKbfDomainKey,
} from './canonical-kbf-domains.js'
import { findAuditedModelKey } from './audited-models.js'

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

/**
 * Pins the reference endpoint's upstream provider (OpenRouter `provider`
 * routing with `allow_fallbacks: false`), so the reference is always served by
 * the same hardware and quantization.
 */
export const VerifierReferenceProviderSchema = strictObject({
  order: uniqueStringsSchema(
    'must be a non-empty string array',
    'must not contain duplicates',
  ).refine((values) => values.length > 0, 'must list at least one provider'),
})

const VerifierApiUpstreamSchema = strictObject({
  type: z.enum(['openrouter', 'openai', 'anthropic']),
  baseUrl: nonEmptyStringSchema,
  apiKey: z.string().optional(),
  apiKeyEnv: nonEmptyStringSchema.optional(),
})

/**
 * One Antseed seller, reached through the local buyer proxy and pinned to its peer id.
 * Only use a seller you trust: if it serves a different model, the reference is wrong too.
 */
const VerifierAntseedUpstreamSchema = strictObject({
  type: z.literal('antseed'),
  peerId: z.string().regex(PEER_ID_PATTERN, 'must be a 40-character hex peer id'),
})

/**
 * A named source of reference answers: OpenRouter, any OpenAI-compatible Chat
 * Completions API, the native Anthropic Messages API, or a trusted Antseed seller.
 */
export const VerifierUpstreamSchema = z.discriminatedUnion('type', [
  VerifierApiUpstreamSchema,
  VerifierAntseedUpstreamSchema,
])

/** Sends a model's own reference requests to a named upstream instead of `referenceEndpoint`. */
export const VerifierModelUpstreamSchema = strictObject({
  name: nonEmptyStringSchema,
  /** Model id on that upstream (the seller's service for `antseed`); defaults to `upstreamModel`. */
  model: nonEmptyStringSchema.optional(),
  /** What the seller charges; required for an `antseed` upstream. */
  pricing: VerifierModelPricingSchema.optional(),
})

const excludedDomainsSchema = z.array(canonicalDomainSchema).superRefine((domains, context) => {
  if (new Set(domains).size !== domains.length) {
    context.addIssue({ code: 'custom', message: 'must not contain duplicates' })
  }
  if (domains.length >= CANONICAL_KBF_DOMAINS.length) {
    context.addIssue({ code: 'custom', message: 'must leave at least one canonical KBF domain enabled' })
  }
})

const modelSettingsShape = {
  enabled: z.boolean().optional(),
  pricing: VerifierModelPricingSchema.optional(),
  referenceRoute: VerifierAntseedReferenceRouteSchema.optional(),
  referenceProvider: VerifierReferenceProviderSchema.optional(),
  upstream: VerifierModelUpstreamSchema.optional(),
  contrastModels: uniqueStringsSchema(
    'must be a string array when provided',
    'must not contain duplicates',
  ).optional(),
  excludedDomains: excludedDomainsSchema.optional(),
}

/**
 * Optional settings for one built-in audited model (`verifier.models.<model>`). The model list
 * itself and each model's reference id are built in (`audited-models.ts`).
 */
export const VerifierModelSettingsSchema = strictObject(modelSettingsShape)

/** A built-in audited model merged with the verifier's settings for it. */
export const VerifierReferenceModelSchema = strictObject({
  ...modelSettingsShape,
  serviceAliases: uniqueStringsSchema(
    'must be a string array when provided',
    'must not duplicate the model service or another alias',
  ).optional(),
  upstreamModel: nonEmptyStringSchema,
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

const contrastModelBankSchema = z.record(z.string(), VerifierContrastModelSchema)
  .refine((models) => Object.keys(models).length > 0, 'must not be empty')

export const VerifierReferenceEndpointSchema = strictObject({
  baseUrl: nonEmptyStringSchema,
  apiKey: z.string().optional(),
  apiKeyEnv: nonEmptyStringSchema.optional(),
  sourceId: nonEmptyStringSchema,
  trust: z.enum(['smoke', 'trusted']),
  antseedPeerId: z.string().regex(PEER_ID_PATTERN, 'must be a 40-character hex peer id').optional(),
  /** No longer supported: the audited model list is built in. Per-model settings go in `verifier.models`. */
  models: z.unknown().optional(),
  contrastModelBank: contrastModelBankSchema.optional(),
})

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

export const VerifierConfigSchema = strictObject({
  /** Auditor address used by `verifier run` for model assignment and by `submit`/`rewards`. */
  auditor: z.string().trim().regex(ADDRESS_PATTERN, 'must be a 0x-prefixed 20-byte address').optional(),
  /** Encrypted JSON keystore (e.g. a Foundry keystore) that signs `submit` and `rewards --claim`. */
  keystore: nonEmptyStringSchema.optional(),
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
  /** Rechecks of a first DIFF on fresh probes before it is submitted: 1 (default) or 0 to turn rechecks off. */
  diffConfirmationRuns: z.number().int().min(0).max(1).optional(),
  /**
   * Sellers are audited only when their price for a model is at most its reference price
   * (OpenRouter by default) times this ratio: 1 (default) is the reference price, 1.1 allows 10% more.
   */
  auditPriceRatio: z.number().finite().positive('must be a finite number > 0').optional(),
  contrastSelection: VerifierContrastSelectionSchema.optional(),
  upstreams: z.record(z.string(), VerifierUpstreamSchema).optional(),
  referenceEndpoint: VerifierReferenceEndpointSchema.optional(),
  models: z.record(z.string(), VerifierModelSettingsSchema).optional(),
  referenceMaxRequestsPerBuild: positiveIntegerSchema.optional(),
  referenceBatchRetryCount: z.number().int().min(0, 'must be an integer >= 0').optional(),
  referenceRetryBaseDelayMs: positiveIntegerSchema.optional(),
  referenceMaxNoProgressRounds: positiveIntegerSchema.optional(),
  referenceSelfTestRuns: positiveIntegerSchema.optional(),
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
  const usesOpenRouterCatalog = config.contrastSelection?.catalogSource === 'openrouter'
    || (config.contrastSelection?.catalogSource === undefined && endpoint?.contrastModelBank === undefined)
  const maxContrastModels = config.contrastSelection?.maxModels ?? 3
  if (config.contrastSelection?.catalogSource === 'openrouter' && endpoint?.contrastModelBank !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['referenceEndpoint', 'contrastModelBank'],
      message: 'must be omitted when contrastSelection.catalogSource is "openrouter"',
    })
  }
  if (endpoint?.models !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['referenceEndpoint', 'models'],
      message: 'is no longer supported: the audited model list is built into the CLI. '
        + 'Remove it and put per-model settings (upstream, referenceProvider, contrastModels, excludedDomains, enabled) in verifier.models',
    })
  }

  const settingsKeys = new Map<string, string>()
  for (const service of Object.keys(config.models ?? {})) {
    const key = findAuditedModelKey(service)
    if (!key) {
      context.addIssue({
        code: 'custom',
        path: ['models', service],
        message: 'is not an audited model; the audited model list is built into the CLI',
      })
    } else if (settingsKeys.has(key)) {
      context.addIssue({
        code: 'custom',
        path: ['models', service],
        message: `configures the same model as verifier.models.${settingsKeys.get(key)}`,
      })
    } else {
      settingsKeys.set(key, service)
    }
  }

  for (const [service, model] of Object.entries(config.models ?? {})) {
    const modelPath = ['models', service] as const
    if (model.referenceProvider && model.referenceRoute) {
      context.addIssue({
        code: 'custom',
        path: [...modelPath, 'referenceProvider'],
        message: 'must be omitted when referenceRoute sends reference requests through an Antseed peer',
      })
    }
    if (model.upstream) {
      const upstream = config.upstreams?.[model.upstream.name]
      if (!upstream) {
        context.addIssue({
          code: 'custom',
          path: [...modelPath, 'upstream', 'name'],
          message: 'must name an entry in verifier.upstreams',
        })
      }
      if (model.referenceRoute) {
        context.addIssue({
          code: 'custom',
          path: [...modelPath, 'upstream'],
          message: 'must be omitted when referenceRoute sends reference requests through an Antseed peer',
        })
      }
      if (model.referenceProvider && upstream && upstream.type !== 'openrouter') {
        context.addIssue({
          code: 'custom',
          path: [...modelPath, 'referenceProvider'],
          message: 'is only supported with an openrouter upstream',
        })
      }
      if (upstream?.type === 'antseed' && !model.upstream.pricing) {
        context.addIssue({
          code: 'custom',
          path: [...modelPath, 'upstream', 'pricing'],
          message: 'is required for an antseed upstream',
        })
      }
    }
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
        message: 'must be omitted when contrast models come from the OpenRouter catalog',
      })
    }
  }
})

export type VerifierCLIConfig = z.infer<typeof VerifierConfigSchema>
export type VerifierContrastSelectionConfig = z.infer<typeof VerifierContrastSelectionSchema>
export type VerifierModelPricingConfig = z.infer<typeof VerifierModelPricingSchema>
export type VerifierAntseedReferenceRouteConfig = z.infer<typeof VerifierAntseedReferenceRouteSchema>
export type VerifierReferenceProviderConfig = z.infer<typeof VerifierReferenceProviderSchema>
export type VerifierReferenceModelConfig = z.infer<typeof VerifierReferenceModelSchema>
export type VerifierModelSettings = z.infer<typeof VerifierModelSettingsSchema>
export type VerifierContrastModelConfig = z.infer<typeof VerifierContrastModelSchema>
export type VerifierUpstreamConfig = z.infer<typeof VerifierUpstreamSchema>
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
