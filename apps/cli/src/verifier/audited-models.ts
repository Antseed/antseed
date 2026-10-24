/**
 * The models the Antseed network audits. Auditors never list models themselves: `verifier run
 * --auditor` assigns models from this list (see `audit-assignment.ts`), and a verifier's config only
 * says where reference answers come from (`verifier.referenceEndpoint`, `verifier.upstreams`) plus
 * optional per-model settings in `verifier.models`.
 *
 * The key is the service name sellers advertise and the probe-bank directory name
 * (`<dataDir>/verifier/banks/<key>`), so renaming a key orphans its bank.
 */
export interface AuditedModel {
  /** Model id on the reference endpoint (OpenRouter id); an upstream can use another id via `upstream.model`. */
  upstreamModel: string
  /** Other service names sellers use for the same model. */
  serviceAliases?: readonly string[]
}

export const AUDITED_MODELS: Readonly<Record<string, AuditedModel>> = Object.freeze({
  'claude-fable-5.1': { upstreamModel: 'anthropic/claude-fable-5.1' },
  'claude-opus-4-6': { upstreamModel: 'anthropic/claude-opus-4.6', serviceAliases: ['claude-opus-4.6'] },
  'claude-opus-5': { upstreamModel: 'anthropic/claude-opus-5' },
  'claude-opus-5.5': { upstreamModel: 'anthropic/claude-opus-5.5', serviceAliases: ['claude-opus-5-5'] },
  'claude-sonnet-5': { upstreamModel: 'anthropic/claude-sonnet-5' },
  'claude-sonnet-5.5': {
    upstreamModel: 'anthropic/claude-sonnet-5.5',
    serviceAliases: ['claude-sonnet-5-5', 'sonnet-5.5'],
  },
  'gemini-3-flash-preview': { upstreamModel: 'google/gemini-3-flash-preview' },
  'gemini-3.1-pro-preview': { upstreamModel: 'google/gemini-3.1-pro-preview' },
  'gpt-5.6-sol': { upstreamModel: 'openai/gpt-5.6-sol' },
  'gpt-6-astra': { upstreamModel: 'openai/gpt-6-astra' },
  'gpt-6.1-sol': { upstreamModel: 'openai/gpt-6.1-sol', serviceAliases: ['openai-gpt-61-sol', 'gpt-61-sol'] },
  'grok-4.5': { upstreamModel: 'x-ai/grok-4.5' },
  'grok-4.7': { upstreamModel: 'x-ai/grok-4.7', serviceAliases: ['grok-4-7'] },
  'kimi-k3': { upstreamModel: 'moonshotai/kimi-k3' },
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

/** The built-in key for a service name or alias, or undefined when the model is not audited. */
export function findAuditedModelKey(service: string): string | undefined {
  const wanted = service.trim().toLowerCase()
  return Object.entries(auditedModels()).find(([key, model]) => [key, ...(model.serviceAliases ?? [])]
    .some((name) => name.trim().toLowerCase() === wanted))?.[0]
}
