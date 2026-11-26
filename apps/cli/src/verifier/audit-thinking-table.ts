/**
 * How little each audited model is asked to think, the same for every auditor: one level, and one fallback for an
 * endpoint that refuses it (`THINKING_TABLE_RULE`). The reference is asked for the level in OpenRouter's field
 * (`reasoning.effort`) and every seller in OpenAI Chat Completions' own field (`reasoning_effort`, which the buyer proxy
 * translates for a seller that speaks another API). Nothing is chosen at run time: the ten test questions only check
 * that the setting is taken and answers. `none` only where the model's maker documents that thinking can be turned
 * off and the genuine route and the model's sellers took it; a model that always thinks gets its documented lowest
 * level. Chosen from a measurement of the genuine route and every seller of each model on the network (November 2026).
 * Part of the audit rules (the verifier compat fingerprint): a change here is a rules change.
 */
import type { ThinkingLevel } from '@antseed/fingerprints'

export interface AuditThinkingEntry {
  /** The level every endpoint is asked with. */
  level: ThinkingLevel
  /** The level an endpoint that refuses `level` (an HTTP 4xx other than 429) is asked with instead; null for none. */
  fallback: ThinkingLevel | null
}

export const AUDIT_THINKING: Readonly<Record<string, Readonly<AuditThinkingEntry>>> = Object.freeze({
  // Thinking cannot be turned off; `low` is the lowest level the maker documents, and every genuine route and nearly
  // every seller took it. `none` is refused by each reference route and by many sellers; `minimal` by some (OpenAI's
  // own API for GPT-6.2), so it is only the fallback.
  'claude-fable-5.2': Object.freeze({ level: 'low', fallback: 'minimal' }),
  'claude-opus-5.5': Object.freeze({ level: 'low', fallback: 'minimal' }),
  'claude-sonnet-5.5': Object.freeze({ level: 'low', fallback: 'minimal' }),
  'gemini-4-argon': Object.freeze({ level: 'low', fallback: 'minimal' }),
  'gemini-4-neon': Object.freeze({ level: 'low', fallback: 'minimal' }),
  'glm-5.3': Object.freeze({ level: 'low', fallback: 'minimal' }),
  'gpt-6.2-astra': Object.freeze({ level: 'low', fallback: 'minimal' }),
  'gpt-6.2-sol': Object.freeze({ level: 'low', fallback: 'minimal' }),
  'grok-4.7': Object.freeze({ level: 'low', fallback: 'minimal' }),
  // Thinking can be turned off: the genuine route and most sellers answer `none` with no reasoning. The fallback is the
  // level that thought less on the genuine route (DeepSeek V4 Pro and MiMo v2.6 Pro think longer at `low`).
  'deepseek-v4-pro': Object.freeze({ level: 'none', fallback: 'minimal' }),
  'kimi-k3': Object.freeze({ level: 'none', fallback: 'low' }),
  'kimi-k3.1-pro': Object.freeze({ level: 'none', fallback: 'low' }),
  'mimo-v2.6-pro': Object.freeze({ level: 'none', fallback: 'minimal' }),
  'qwen3.8-27b': Object.freeze({ level: 'none', fallback: 'low' }),
})

/** The audited model's entry; undefined for a model the table does not name (a model a config adds). */
export function auditThinkingFor(model: string): Readonly<AuditThinkingEntry> | undefined {
  return AUDIT_THINKING[model.trim().toLowerCase()]
}

/**
 * The entry for a model's bank: the table's when the bank's reference was asked on OpenRouter with a provider pin
 * (`generator.params.referenceProvider.pinned`), where the table's reference field is OpenRouter's `reasoning.effort`;
 * undefined for a bank asked on a maker's own API (a configured reference upstream), which keeps thinking discovery,
 * and for a model the table does not name.
 */
export function auditThinkingForBank(
  model: string,
  bank: { generator?: { params?: Readonly<Record<string, unknown>> } },
): Readonly<AuditThinkingEntry> | undefined {
  const pinned = (bank.generator?.params?.['referenceProvider'] as { pinned?: unknown } | undefined)?.pinned
  return pinned !== null && typeof pinned === 'object' ? auditThinkingFor(model) : undefined
}
