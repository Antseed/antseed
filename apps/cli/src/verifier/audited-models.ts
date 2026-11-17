import { canonicalModelKey } from '@antseed/node/model-identity'

/**
 * The models the Antseed network audits. Auditors never list models themselves: `verifier run
 * --auditor` assigns models from this list (see `audit-assignment.ts`), and a verifier's config only
 * says where reference answers come from (`verifier.referenceEndpoint`, `verifier.upstreams`) plus
 * optional per-model settings in `verifier.models`.
 *
 * Only the newest version of each model line is audited: older versions that a newer audited
 * model replaces (Claude Sonnet 5, Opus 4.6 and Opus 5, GPT-5.6 Sol, Grok 4.5) are left out, and so
 * are Gemini 3 Flash Preview and DeepSeek V4 Pro 0813.
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
   * `verifier.models.<model>.referenceProvider` overrides it. Each epoch's bank keeps the pin its first
   * build used; a pinned provider OpenRouter no longer lists is replaced then (`listedProviderOrder`).
   */
  referenceProvider?: readonly string[]
  /**
   * Look-alike OpenRouter models a new bank must tell this model apart from, so every verifier's new
   * banks use the same reviewed set. Each is cheaper than this model (what a substituting seller would
   * serve) and one the audits' banks already use. Never a `:free` model (daily limits make builds
   * time out). `verifier.models.<model>.contrastModels` overrides it; a bank keeps the contrasts it
   * was built with.
   */
  contrastModels: readonly string[]
}

const ANTHROPIC = ['anthropic'] as const
const GOOGLE = ['google-ai-studio'] as const
const OPENAI = ['openai'] as const

export const AUDITED_MODELS: Readonly<Record<string, AuditedModel>> = Object.freeze({
  'claude-fable-5.1': {
    upstreamModel: 'anthropic/claude-fable-5.1',
    referenceProvider: ANTHROPIC,
    serviceAliases: ['claude-fable-5-1', 'fable-5.1', 'fable-5-1', 'anthropic/claude-fable-5.1'],
    contrastModels: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-terra'],
  },
  'claude-opus-5.5': {
    upstreamModel: 'anthropic/claude-opus-5.5',
    referenceProvider: ANTHROPIC,
    serviceAliases: ['claude-opus-5-5', 'opus-5.5', 'opus-5-5', 'anthropic/claude-opus-5.5'],
    contrastModels: ['anthropic/claude-haiku-5.5', 'meta/muse-spark-1.3', 'openai/gpt-6.1-terra'],
  },
  'claude-sonnet-5.5': {
    upstreamModel: 'anthropic/claude-sonnet-5.5',
    referenceProvider: ANTHROPIC,
    serviceAliases: ['claude-sonnet-5-5', 'sonnet-5.5', 'sonnet-5-5', 'anthropic/claude-sonnet-5.5'],
    contrastModels: ['anthropic/claude-haiku-5.5', 'xiaomi/mimo-v2.6-pro', 'z-ai/glm-5.3'],
  },
  'gemini-3.1-pro-preview': {
    upstreamModel: 'google/gemini-3.1-pro-preview',
    referenceProvider: GOOGLE,
    serviceAliases: ['gemini-3-1-pro-preview', 'google/gemini-3.1-pro-preview'],
    contrastModels: ['anthropic/claude-haiku-5.5', 'xiaomi/mimo-v2.6-pro', 'z-ai/glm-5.3'],
  },
  'gemini-4-argon': {
    upstreamModel: 'google/gemini-4-argon',
    referenceProvider: GOOGLE,
    serviceAliases: ['google/gemini-4-argon'],
    contrastModels: ['anthropic/claude-haiku-5.5', 'xiaomi/mimo-v2.6-pro', 'z-ai/glm-5.3'],
  },
  'gpt-6-astra': {
    upstreamModel: 'openai/gpt-6-astra',
    referenceProvider: OPENAI,
    serviceAliases: ['openai/gpt-6-astra', 'openai-gpt-6-astra'],
    contrastModels: ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-terra'],
  },
  'gpt-6.1-sol': {
    upstreamModel: 'openai/gpt-6.1-sol',
    referenceProvider: OPENAI,
    serviceAliases: ['openai-gpt-61-sol', 'gpt-61-sol', 'openai/gpt-6.1-sol'],
    contrastModels: ['anthropic/claude-haiku-5.5', 'xiaomi/mimo-v2.6-pro', 'z-ai/glm-5.3'],
  },
  'grok-4.7': {
    upstreamModel: 'x-ai/grok-4.7',
    referenceProvider: ['xai'],
    serviceAliases: ['grok-4-7', 'x-ai/grok-4.7'],
    contrastModels: ['anthropic/claude-haiku-5.5', 'xiaomi/mimo-v2.6-pro', 'z-ai/glm-5.3'],
  },
  // OpenRouter has no DeepSeek endpoint for this model. Nebius (fp8) answers with thinking off, at
  // 3.9% self-test error and 4.7% on real batches; Baidu no longer reproduced its own bank.
  'deepseek-v4-pro': {
    upstreamModel: 'deepseek/deepseek-v4-pro',
    referenceProvider: ['nebius/fp8'],
    serviceAliases: ['deepseek/deepseek-v4-pro'],
    contrastModels: ['anthropic/claude-haiku-5.5', 'xiaomi/mimo-v2.6-pro', 'z-ai/glm-5.3'],
  },
  'kimi-k3': {
    upstreamModel: 'moonshotai/kimi-k3',
    referenceProvider: ['moonshotai'],
    serviceAliases: ['moonshotai/kimi-k3', 'moonshot/kimi-k3', 'kimi-k3:fast', 'kimi-k3-fast', 'kimi-k3-fast-api'],
    contrastModels: ['anthropic/claude-haiku-5.5', 'xiaomi/mimo-v2.6-pro', 'z-ai/glm-5.3'],
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
    contrastModels: ['anthropic/claude-haiku-5.5', 'xiaomi/mimo-v2.6-pro', 'z-ai/glm-5.3'],
  },
  'glm-5.3': {
    upstreamModel: 'z-ai/glm-5.3',
    referenceProvider: ['z-ai/fp8'],
    serviceAliases: ['glm-5-3', 'z-ai/glm-5.3', 'zai/glm-5.3', 'z-ai-glm-5-3'],
    contrastModels: ['z-ai/glm-5.3-flash', 'deepseek/deepseek-v4.1-flash-1017', 'openai/gpt-6-luna'],
  },
  'qwen3.8-27b': {
    upstreamModel: 'qwen/qwen3.8-27b',
    referenceProvider: ['alibaba'],
    serviceAliases: ['qwen-3-8-27b', 'qwen-3.8-27b', 'qwen3-8-27b', 'qwen/qwen3.8-27b'],
    contrastModels: ['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash-1017', 'openai/gpt-6-luna'],
  },
  'minimax-m3': {
    upstreamModel: 'minimax/minimax-m3',
    referenceProvider: ['minimax'],
    serviceAliases: ['minimax/minimax-m3', 'minimax-m-3'],
    contrastModels: ['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash-1017', 'openai/gpt-6-luna'],
  },
  'mimo-v2.6-pro': {
    upstreamModel: 'xiaomi/mimo-v2.6-pro',
    referenceProvider: ['xiaomi/fp8'],
    serviceAliases: ['xiaomi/mimo-v2.6-pro', 'mimo-v2-6-pro'],
    contrastModels: ['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash-1017', 'openai/gpt-6-luna'],
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
