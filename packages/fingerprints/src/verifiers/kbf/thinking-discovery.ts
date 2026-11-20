/**
 * Thinking suppression, discovered per endpoint the way the KBF reference code
 * does it (`discover_thinking_strategy` in kbf_common.py at upstream commit 6b4c403;
 * the `2026-09-30` in the method id is the date of paper v3). It runs for every
 * endpoint it queries, reference and audited target alike.
 * Providers disable hidden reasoning in incompatible ways, and some accept a
 * field but ignore it. So each strategy is tried in order on a fixed
 * ten-question test batch, and the first one that returns at least 5/10
 * parseable answers with zero reasoning tokens is kept (`bare` may think). If
 * none works, `bare` is retried with 50 times the token budget so the model has
 * room to think and still answer (`bare-expanded`).
 *
 * Unlike the reference code, a strategy must also leave the reply as only the
 * numbered answers and must not hit the token limit. Some upstreams turn the
 * thinking channel off but let the model reason in its reply instead (GLM-5.3 on
 * DeepInfra with `reasoning: {effort: "none"}`): that reports no reasoning tokens
 * and passes the reference check, but on real audit questions the reasoning runs
 * past the token limit and the parsed numbers come from the reasoning.
 */
import type { KbfProbe } from '../../types.js';
import { isKbfAnswersOnlyReply, parseKbfAnswers } from './parser.js';
import { KBF_THINKING_PREFILL, type ReferenceReasoningStrategy } from './reference.js';

export const THINKING_DISCOVERY_STRATEGIES = [
  'reasoning-effort-none',
  'reasoning-effort-minimal',
  'disable-thinking',
  'enable-thinking-false',
  'prefill',
  'bare',
] as const satisfies readonly ReferenceReasoningStrategy[];

export type ThinkingDiscoveryStrategy = typeof THINKING_DISCOVERY_STRATEGIES[number] | 'bare-expanded';

/** Ten answers at 80 tokens each, as the reference code budgets a ten-question batch. */
export const THINKING_DISCOVERY_MAX_TOKENS = 80 * 10;
export const THINKING_FALLBACK_TOKEN_MULTIPLIER = 50;
/** Token budget per request when nothing suppresses thinking (`bare-expanded`). */
export const THINKING_FALLBACK_MAX_TOKENS = THINKING_DISCOVERY_MAX_TOKENS * THINKING_FALLBACK_TOKEN_MULTIPLIER;
/** An unsuppressed endpoint is still thinking, so the discovery request is the slowest one sent. */
export const THINKING_DISCOVERY_TIMEOUT_MS = 600_000;
export const THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS = 5;

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
];

/** The fixed discovery batch from the KBF reference code, as KBF probes. */
export const THINKING_DISCOVERY_PROBES: readonly KbfProbe[] = Object.freeze(DISCOVERY_FACTS.map(([template, value], index) => ({
  id: `thinking-discovery-${index + 1}`,
  name: `thinking discovery ${index + 1}`,
  domain: 'thinking_discovery',
  template,
  consensus: value,
  range: [-1e9, 1e9] as [number, number],
  tolerance: { mode: 'relative' as const, value: 0.05 },
})));

export interface ThinkingStrategyRequest {
  /** Extra request fields that carry the strategy. */
  overrides: Record<string, unknown>;
  /** Assistant message appended to the conversation (`prefill` only). */
  assistantPrefill?: typeof KBF_THINKING_PREFILL;
  /** Token budget floor (`bare-expanded` only). */
  maxTokens?: number;
}

export function thinkingStrategyRequest(strategy: ThinkingDiscoveryStrategy): ThinkingStrategyRequest {
  switch (strategy) {
    case 'reasoning-effort-none': return { overrides: { reasoning: { effort: 'none' } } };
    case 'reasoning-effort-minimal': return { overrides: { reasoning: { effort: 'minimal' } } };
    case 'disable-thinking': return { overrides: { thinking: { type: 'disabled' } } };
    case 'enable-thinking-false': return { overrides: { enable_thinking: false } };
    case 'prefill': return { overrides: {}, assistantPrefill: KBF_THINKING_PREFILL };
    case 'bare': return { overrides: {} };
    case 'bare-expanded': return { overrides: {}, maxTokens: THINKING_FALLBACK_MAX_TOKENS };
  }
}

export interface ThinkingDiscoveryAttemptV1 {
  strategy: ThinkingDiscoveryStrategy;
  maxTokens: number;
  /** HTTP status of a refused request, or null for transport failures and answers. */
  status: number | null;
  /** Parseable answers out of ten; null when the request failed. */
  validAnswers: number | null;
  reasoningTokens: number | null;
  /** False when the reply held more than the numbered answers (the model reasoned in it). */
  answersOnly?: boolean;
  /** True when the reply stopped at the token limit. */
  truncated?: boolean;
  failure?: string;
}

export interface ThinkingDiscoveryResultV1 extends ThinkingStrategyRequest {
  strategy: ThinkingDiscoveryStrategy;
  attempts: ThinkingDiscoveryAttemptV1[];
}

export type ThinkingDiscoveryProbe = (input: {
  strategy: ThinkingDiscoveryStrategy;
  request: ThinkingStrategyRequest;
  maxTokens: number;
}) => Promise<
  | { ok: true; content: string | null; reasoningTokens: number; truncated?: boolean }
  | { ok: false; status: number | null; failure: string }
>;

/**
 * True for a finish reason meaning the reply stopped at the token limit: OpenAI `length`,
 * Anthropic `max_tokens`, OpenAI Responses `incomplete` / `max_output_tokens`.
 */
export function isKbfTokenLimitFinishReason(reason: string | null | undefined): boolean {
  if (typeof reason !== 'string') return false;
  const normalized = reason.trim().toLowerCase();
  return normalized === 'length' || normalized === 'max_tokens' || normalized === 'incomplete' || normalized === 'max_output_tokens';
}

/** The finish reason of an OpenAI-style, Anthropic or Responses API JSON body; null when absent. */
export function kbfResponseFinishReason(responseBody: string): string | null {
  try {
    const parsed = JSON.parse(responseBody) as {
      choices?: Array<{ finish_reason?: unknown }>;
      stop_reason?: unknown;
      status?: unknown;
      incomplete_details?: { reason?: unknown };
    };
    const reason = parsed.choices?.[0]?.finish_reason ?? parsed.stop_reason ?? parsed.incomplete_details?.reason ?? parsed.status;
    return typeof reason === 'string' ? reason : null;
  } catch {
    return null;
  }
}

export class ThinkingDiscoveryError extends Error {
  constructor(message: string, readonly attempts: ThinkingDiscoveryAttemptV1[]) {
    super(message);
    this.name = 'ThinkingDiscoveryError';
  }
}

/**
 * Counts the parseable answers a discovery response gives to the fixed batch, after removing
 * `<think>` blocks as the audit does, so answers that only appear inside a thinking block (which
 * the audit discards) do not make a strategy look usable.
 */
export function countDiscoveryAnswers(content: string | null): number {
  if (content === null) return 0;
  return parseKbfAnswers(stripKbfThinkBlocks(content), THINKING_DISCOVERY_PROBES.length).filter((answer) => answer !== null).length;
}

/**
 * `usage.completion_tokens_details.reasoning_tokens` of an OpenAI-style response body, as the
 * reference code reads it to reject a strategy the endpoint accepts but ignores; 0 when absent.
 */
export function reportedReasoningTokens(responseBody: string): number {
  try {
    const parsed = JSON.parse(responseBody) as { usage?: { completion_tokens_details?: { reasoning_tokens?: unknown } } };
    const tokens = Number(parsed.usage?.completion_tokens_details?.reasoning_tokens ?? 0);
    return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  } catch {
    return 0;
  }
}

/** Removes `<think>…</think>` blocks from an answer, as the reference code does before parsing a batch. */
export function stripKbfThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export async function discoverThinkingSuppression(input: {
  model: string;
  label: string;
  /** Prefill only applies to OpenAI Chat Completions, as in the reference code. */
  supportsPrefill: boolean;
  probe: ThinkingDiscoveryProbe;
  log?: (message: string) => void;
}): Promise<ThinkingDiscoveryResultV1> {
  const attempts: ThinkingDiscoveryAttemptV1[] = [];
  const tryOnce = async (strategy: ThinkingDiscoveryStrategy, maxTokens: number): Promise<ThinkingDiscoveryAttemptV1> => {
    const request = thinkingStrategyRequest(strategy);
    const outcome = await input.probe({ strategy, request, maxTokens });
    const attempt: ThinkingDiscoveryAttemptV1 = outcome.ok
      ? {
        strategy,
        maxTokens,
        status: null,
        validAnswers: countDiscoveryAnswers(outcome.content),
        reasoningTokens: outcome.reasoningTokens,
        answersOnly: outcome.content === null || isKbfAnswersOnlyReply(stripKbfThinkBlocks(outcome.content)),
        truncated: outcome.truncated === true,
      }
      : { strategy, maxTokens, status: outcome.status, validAnswers: null, reasoningTokens: null, failure: outcome.failure };
    attempts.push(attempt);
    return attempt;
  };
  for (const strategy of THINKING_DISCOVERY_STRATEGIES) {
    if (strategy === 'prefill' && !input.supportsPrefill) continue;
    const attempt = await tryOnce(strategy, THINKING_DISCOVERY_MAX_TOKENS);
    const valid = attempt.validAnswers ?? -1;
    const cleanReply = attempt.answersOnly !== false && attempt.truncated !== true;
    // `bare` is the no-suppression baseline and may think. Any other strategy
    // that still reports reasoning tokens was accepted but ignored. A reply that
    // reasons in the open or stops at the token limit fails any strategy.
    if (valid >= THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS && cleanReply && (strategy === 'bare' || attempt.reasoningTokens === 0)) {
      input.log?.(
        `thinking suppression for ${input.model}: '${strategy}' works on ${input.label} `
        + `(${valid}/10 parseable, reasoning_tokens=${attempt.reasoningTokens})`,
      );
      return { strategy, ...thinkingStrategyRequest(strategy), attempts };
    }
    if (valid >= THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS && !cleanReply) {
      input.log?.(
        `thinking suppression for ${input.model}: '${strategy}' answered, but `
        + `${attempt.truncated ? 'the reply stopped at the token limit' : 'the model reasoned in its reply'}; trying next`,
      );
    } else if (valid >= THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS) {
      input.log?.(
        `thinking suppression for ${input.model}: '${strategy}' accepted but ignored `
        + `(reasoning_tokens=${attempt.reasoningTokens}); trying next`,
      );
    }
  }
  const expanded = await tryOnce('bare-expanded', THINKING_FALLBACK_MAX_TOKENS);
  // `bare-expanded` lets the model think in the open, so only a reply cut off at the limit fails it.
  if ((expanded.validAnswers ?? -1) >= THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS && expanded.truncated !== true) {
    input.log?.(
      `thinking suppression for ${input.model}: no strategy worked; using 'bare' with `
      + `${THINKING_FALLBACK_TOKEN_MULTIPLIER}x the token budget (${THINKING_FALLBACK_MAX_TOKENS} tokens per request, `
      + `${expanded.validAnswers}/10 parseable). Every request may think, so cost is higher`,
    );
    return { strategy: 'bare-expanded', ...thinkingStrategyRequest('bare-expanded'), attempts };
  }
  const failures = attempts.filter((attempt) => attempt.validAnswers === null);
  const statuses = new Set(failures.map((attempt) => attempt.status));
  if (failures.length === attempts.length && statuses.size === 1 && failures[0]!.status !== null && failures[0]!.status >= 400) {
    throw new ThinkingDiscoveryError(
      `${input.label} refused every request for ${input.model} with HTTP ${failures[0]!.status}, so the problem is the `
      + `upstream (model id, provider pin, API key), not thinking suppression: ${failures[0]!.failure ?? ''}`,
      attempts,
    );
  }
  const detail = attempts.map((attempt) => attempt.validAnswers === null
    ? `${attempt.strategy}: ${attempt.status === null ? 'failed' : `HTTP ${attempt.status}`} ${(attempt.failure ?? '').slice(0, 160)}`
    : `${attempt.strategy}: ${attempt.validAnswers}/10 parseable, reasoning_tokens=${attempt.reasoningTokens}`
      + `${attempt.answersOnly === false ? ', reasoned in reply' : ''}${attempt.truncated ? ', hit token limit' : ''}`).join('; ');
  throw new ThinkingDiscoveryError(
    `no thinking-suppression strategy worked for ${input.model} on ${input.label}, even 'bare' with `
    + `${THINKING_FALLBACK_MAX_TOKENS} tokens: ${detail}`,
    attempts,
  );
}
