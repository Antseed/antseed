/**
 * Thinking suppression, discovered per reference route the way the KBF
 * reference code does it (`discover_thinking_strategy` in kbf_common.py,
 * 30 Sep 2026). Providers disable hidden reasoning in incompatible ways, and
 * some accept a field but ignore it. So each strategy is tried in order on a
 * fixed ten-question test batch, and the first one that returns at least 5/10
 * parseable answers with zero reasoning tokens is kept (`bare` may think). If
 * none works, `bare` is retried with 50 times the token budget so the model has
 * room to think and still answer (`bare-expanded`).
 */
import {
  KBF_THINKING_PREFILL,
  parseKbfAnswers,
  type KbfProbe,
  type ReferenceReasoningStrategy,
} from '@antseed/fingerprints'

export const THINKING_DISCOVERY_STRATEGIES = [
  'reasoning-effort-none',
  'reasoning-effort-minimal',
  'disable-thinking',
  'enable-thinking-false',
  'prefill',
  'bare',
] as const satisfies readonly ReferenceReasoningStrategy[]

export type ThinkingDiscoveryStrategy = typeof THINKING_DISCOVERY_STRATEGIES[number] | 'bare-expanded'

/** Ten answers at 80 tokens each, as the reference code budgets a ten-question batch. */
export const THINKING_DISCOVERY_MAX_TOKENS = 80 * 10
export const THINKING_FALLBACK_TOKEN_MULTIPLIER = 50
/** Token budget per request when nothing suppresses thinking (`bare-expanded`). */
export const THINKING_FALLBACK_MAX_TOKENS = THINKING_DISCOVERY_MAX_TOKENS * THINKING_FALLBACK_TOKEN_MULTIPLIER
/** An unsuppressed endpoint is still thinking, so the discovery request is the slowest one sent. */
export const THINKING_DISCOVERY_TIMEOUT_MS = 600_000
export const THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS = 5

const DISCOVERY_FACTS: ReadonlyArray<readonly [string, number]> = [
  ['The boiling point of ethanol at standard pressure in degrees Celsius is ___', 78.37],
  ['The atomic number of gold is ___', 79],
  ['The speed of light in vacuum in metres per second is ___', 299_792_458],
  ['The melting point of iron in degrees Celsius is ___', 1538],
  ['The number of bones in an adult human body is ___', 206],
  ['The atomic mass of carbon-12 in unified atomic mass units is ___', 12],
  ['The boiling point of water at standard pressure in degrees Celsius is ___', 100],
  ["The gravitational acceleration on Earth's surface in metres per second squared is ___", 9.81],
  ['The atomic number of oxygen is ___', 8],
  ['The melting point of pure ice at standard pressure in degrees Celsius is ___', 0],
]

/** The fixed discovery batch from the KBF reference code, as KBF probes. */
export const THINKING_DISCOVERY_PROBES: readonly KbfProbe[] = Object.freeze(DISCOVERY_FACTS.map(([template, value], index) => ({
  id: `thinking-discovery-${index + 1}`,
  name: `thinking discovery ${index + 1}`,
  domain: 'thinking_discovery',
  template,
  consensus: value,
  range: [-1e9, 1e9] as [number, number],
  tolerance: { mode: 'relative' as const, value: 0.05 },
})))

export interface ThinkingStrategyRequest {
  /** Extra request fields that carry the strategy. */
  overrides: Record<string, unknown>
  /** Assistant message appended to the conversation (`prefill` only). */
  assistantPrefill?: typeof KBF_THINKING_PREFILL
  /** Token budget floor (`bare-expanded` only). */
  maxTokens?: number
}

export function thinkingStrategyRequest(strategy: ThinkingDiscoveryStrategy): ThinkingStrategyRequest {
  switch (strategy) {
    case 'reasoning-effort-none': return { overrides: { reasoning: { effort: 'none' } } }
    case 'reasoning-effort-minimal': return { overrides: { reasoning: { effort: 'minimal' } } }
    case 'disable-thinking': return { overrides: { thinking: { type: 'disabled' } } }
    case 'enable-thinking-false': return { overrides: { enable_thinking: false } }
    case 'prefill': return { overrides: {}, assistantPrefill: KBF_THINKING_PREFILL }
    case 'bare': return { overrides: {} }
    case 'bare-expanded': return { overrides: {}, maxTokens: THINKING_FALLBACK_MAX_TOKENS }
  }
}

export interface ThinkingDiscoveryAttemptV1 {
  strategy: ThinkingDiscoveryStrategy
  maxTokens: number
  /** HTTP status of a refused request, or null for transport failures and answers. */
  status: number | null
  /** Parseable answers out of ten; null when the request failed. */
  validAnswers: number | null
  reasoningTokens: number | null
  failure?: string
}

export interface ThinkingDiscoveryResultV1 extends ThinkingStrategyRequest {
  strategy: ThinkingDiscoveryStrategy
  attempts: ThinkingDiscoveryAttemptV1[]
}

export type ThinkingDiscoveryProbe = (input: {
  strategy: ThinkingDiscoveryStrategy
  request: ThinkingStrategyRequest
  maxTokens: number
}) => Promise<
  | { ok: true; content: string | null; reasoningTokens: number }
  | { ok: false; status: number | null; failure: string }
>

export class ThinkingDiscoveryError extends Error {
  constructor(message: string, readonly attempts: ThinkingDiscoveryAttemptV1[]) {
    super(message)
    this.name = 'ThinkingDiscoveryError'
  }
}

/** Counts the parseable answers a discovery response gives to the fixed batch. */
export function countDiscoveryAnswers(content: string | null): number {
  if (content === null) return 0
  return parseKbfAnswers(content, THINKING_DISCOVERY_PROBES.length).filter((answer) => answer !== null).length
}

export async function discoverThinkingSuppression(input: {
  model: string
  label: string
  /** Prefill only applies to OpenAI Chat Completions, as in the reference code. */
  supportsPrefill: boolean
  probe: ThinkingDiscoveryProbe
  log?: (message: string) => void
}): Promise<ThinkingDiscoveryResultV1> {
  const attempts: ThinkingDiscoveryAttemptV1[] = []
  const tryOnce = async (strategy: ThinkingDiscoveryStrategy, maxTokens: number): Promise<ThinkingDiscoveryAttemptV1> => {
    const request = thinkingStrategyRequest(strategy)
    const outcome = await input.probe({ strategy, request, maxTokens })
    const attempt: ThinkingDiscoveryAttemptV1 = outcome.ok
      ? {
        strategy,
        maxTokens,
        status: null,
        validAnswers: countDiscoveryAnswers(outcome.content),
        reasoningTokens: outcome.reasoningTokens,
      }
      : { strategy, maxTokens, status: outcome.status, validAnswers: null, reasoningTokens: null, failure: outcome.failure }
    attempts.push(attempt)
    return attempt
  }
  for (const strategy of THINKING_DISCOVERY_STRATEGIES) {
    if (strategy === 'prefill' && !input.supportsPrefill) continue
    const attempt = await tryOnce(strategy, THINKING_DISCOVERY_MAX_TOKENS)
    const valid = attempt.validAnswers ?? -1
    // `bare` is the no-suppression baseline and may think. Any other strategy
    // that still reports reasoning tokens was accepted but ignored.
    if (valid >= THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS && (strategy === 'bare' || attempt.reasoningTokens === 0)) {
      input.log?.(
        `thinking suppression for ${input.model}: '${strategy}' works on ${input.label} `
        + `(${valid}/10 parseable, reasoning_tokens=${attempt.reasoningTokens})`,
      )
      return { strategy, ...thinkingStrategyRequest(strategy), attempts }
    }
    if (valid >= THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS) {
      input.log?.(
        `thinking suppression for ${input.model}: '${strategy}' accepted but ignored `
        + `(reasoning_tokens=${attempt.reasoningTokens}); trying next`,
      )
    }
  }
  const expanded = await tryOnce('bare-expanded', THINKING_FALLBACK_MAX_TOKENS)
  if ((expanded.validAnswers ?? -1) >= THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS) {
    input.log?.(
      `thinking suppression for ${input.model}: no strategy worked; using 'bare' with `
      + `${THINKING_FALLBACK_TOKEN_MULTIPLIER}x the token budget (${THINKING_FALLBACK_MAX_TOKENS} tokens per request, `
      + `${expanded.validAnswers}/10 parseable). Every request may think, so cost is higher`,
    )
    return { strategy: 'bare-expanded', ...thinkingStrategyRequest('bare-expanded'), attempts }
  }
  const failures = attempts.filter((attempt) => attempt.validAnswers === null)
  const statuses = new Set(failures.map((attempt) => attempt.status))
  if (failures.length === attempts.length && statuses.size === 1 && failures[0]!.status !== null && failures[0]!.status >= 400) {
    throw new ThinkingDiscoveryError(
      `${input.label} refused every request for ${input.model} with HTTP ${failures[0]!.status}, so the problem is the `
      + `upstream (model id, provider pin, API key), not thinking suppression: ${failures[0]!.failure ?? ''}`,
      attempts,
    )
  }
  const detail = attempts.map((attempt) => attempt.validAnswers === null
    ? `${attempt.strategy}: ${attempt.status === null ? 'failed' : `HTTP ${attempt.status}`} ${(attempt.failure ?? '').slice(0, 160)}`
    : `${attempt.strategy}: ${attempt.validAnswers}/10 parseable, reasoning_tokens=${attempt.reasoningTokens}`).join('; ')
  throw new ThinkingDiscoveryError(
    `no thinking-suppression strategy worked for ${input.model} on ${input.label}, even 'bare' with `
    + `${THINKING_FALLBACK_MAX_TOKENS} tokens: ${detail}`,
    attempts,
  )
}
