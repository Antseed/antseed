import { canonicalModelKey } from '@antseed/node/model-identity'

/**
 * The models the Antseed network audits. Auditors never list models themselves: `verifier run
 * --auditor` assigns models from this list (see `audit-assignment.ts`), and a verifier's config only
 * says where reference answers come from (`verifier.referenceEndpoint`, `verifier.upstreams`) plus
 * optional per-model settings in `verifier.models`.
 *
 * Only the newest version of each model line is audited: older versions that a newer audited
 * model replaces (Claude Sonnet 5, Opus 4.6 and Opus 5, GPT-5.6 Sol, Grok 4.5) are left out.
 *
 * The key is the service name sellers advertise and the probe-bank directory name
 * (`<dataDir>/verifier/banks/<key>`), so renaming a key orphans its bank.
 */
export interface AuditedModel {
  /** Model id on the reference endpoint (OpenRouter id); an upstream can use another id via `upstream.model`. */
  upstreamModel: string
  /** Other service names sellers use for the same model. */
  serviceAliases?: readonly string[]
  /**
   * OpenRouter endpoint the reference is pinned to (`provider.order`, no fallbacks), as the KBF
   * reference code pins one provider per model: an unpinned reference is answered by whichever
   * host OpenRouter picks (often fp4/mxfp4 quantizations), which inflates the self-test error and
   * makes honest sellers look like a different model. Prefer the model maker's own endpoint.
   * `verifier.models.<model>.referenceProvider` overrides it; a bank keeps the pin it was built with.
   */
  referenceProvider?: readonly string[]
}

const ANTHROPIC = ['anthropic'] as const
const GOOGLE = ['google-ai-studio'] as const
const OPENAI = ['openai'] as const

export const AUDITED_MODELS: Readonly<Record<string, AuditedModel>> = Object.freeze({
  'claude-fable-5.1': {
    upstreamModel: 'anthropic/claude-fable-5.1',
    referenceProvider: ANTHROPIC,
    serviceAliases: ['claude-fable-5-1', 'fable-5.1', 'fable-5-1', 'anthropic/claude-fable-5.1'],
  },
  'claude-opus-5.5': {
    upstreamModel: 'anthropic/claude-opus-5.5',
    referenceProvider: ANTHROPIC,
    serviceAliases: ['claude-opus-5-5', 'opus-5.5', 'opus-5-5', 'anthropic/claude-opus-5.5'],
  },
  'claude-sonnet-5.5': {
    upstreamModel: 'anthropic/claude-sonnet-5.5',
    referenceProvider: ANTHROPIC,
    serviceAliases: ['claude-sonnet-5-5', 'sonnet-5.5', 'sonnet-5-5', 'anthropic/claude-sonnet-5.5'],
  },
  'gemini-3-flash-preview': { upstreamModel: 'google/gemini-3-flash-preview', referenceProvider: GOOGLE },
  'gemini-3.1-pro-preview': {
    upstreamModel: 'google/gemini-3.1-pro-preview',
    referenceProvider: GOOGLE,
    serviceAliases: ['gemini-3-1-pro-preview', 'google/gemini-3.1-pro-preview'],
  },
  'gemini-4-argon': {
    upstreamModel: 'google/gemini-4-argon',
    referenceProvider: GOOGLE,
    serviceAliases: ['google/gemini-4-argon'],
  },
  'gpt-6-astra': {
    upstreamModel: 'openai/gpt-6-astra',
    referenceProvider: OPENAI,
    serviceAliases: ['openai/gpt-6-astra', 'openai-gpt-6-astra'],
  },
  'gpt-6.1-sol': {
    upstreamModel: 'openai/gpt-6.1-sol',
    referenceProvider: OPENAI,
    serviceAliases: ['openai-gpt-61-sol', 'gpt-61-sol', 'openai/gpt-6.1-sol'],
  },
  'grok-4.7': { upstreamModel: 'x-ai/grok-4.7', referenceProvider: ['xai'], serviceAliases: ['grok-4-7', 'x-ai/grok-4.7'] },
  // OpenRouter has no DeepSeek endpoint for this model; Baidu (fp8) had the lowest self-test error
  // of the hosts that answered past builds.
  'deepseek-v4-pro': {
    upstreamModel: 'deepseek/deepseek-v4-pro',
    referenceProvider: ['baidu/fp8'],
    serviceAliases: ['deepseek/deepseek-v4-pro'],
  },
  'deepseek-v4-pro-0813': {
    upstreamModel: 'deepseek/deepseek-v4-pro-0813',
    referenceProvider: ['deepseek'],
    serviceAliases: ['deepseek/deepseek-v4-pro-0813'],
  },
  'kimi-k3': {
    upstreamModel: 'moonshotai/kimi-k3',
    referenceProvider: ['moonshotai'],
    serviceAliases: ['moonshotai/kimi-k3', 'moonshot/kimi-k3', 'kimi-k3:fast', 'kimi-k3-fast', 'kimi-k3-fast-api'],
  },
  'kimi-k3.1-pro': {
    upstreamModel: 'moonshotai/kimi-k3.1-pro',
    referenceProvider: ['moonshotai/mxfp4'],
    serviceAliases: [
      'kimi-k3-1-pro',
      'moonshotai/kimi-k3.1-pro',
      'kimi-k3.1-pro-highspeed',
      'kimi-k3-1-pro-highspeed',
    ],
  },
  'glm-5.3': {
    upstreamModel: 'z-ai/glm-5.3',
    referenceProvider: ['z-ai/fp8'],
    serviceAliases: ['glm-5-3', 'z-ai/glm-5.3', 'zai/glm-5.3', 'z-ai-glm-5-3'],
  },
})

let override: Readonly<Record<string, AuditedModel>> | null = null

/** The audited model list currently in effect. */
export function auditedModels(): Readonly<Record<string, AuditedModel>> {
  return override ?? AUDITED_MODELS
}

/** Replaces the built-in list for tests; pass `null` to restore it. */
export function setAuditedModelsForTesting(models: Readonly<Record<string, AuditedModel>> | null): void {
  override = models
}

/**
 * The built-in key for a service name or alias, or undefined when the model is not audited. An
 * exact name (any case) wins; otherwise the name is matched by canonical model key the way buyers
 * route, so `anthropic/claude-opus-5.5` or `claude-opus-5-5-latest` finds `claude-opus-5.5`.
 */
export function findAuditedModelKey(service: string): string | undefined {
  const wanted = service.trim().toLowerCase()
  const entries = Object.entries(auditedModels())
  const names = ([key, model]: [string, AuditedModel]) => [key, ...(model.serviceAliases ?? [])]
  const exact = entries.find((entry) => names(entry).some((name) => name.trim().toLowerCase() === wanted))
  if (exact) return exact[0]
  const canonical = canonicalModelKey(wanted)
  if (!canonical) return undefined
  return entries.find((entry) => names(entry).some((name) => canonicalModelKey(name) === canonical))?.[0]
}
