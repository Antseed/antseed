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

export type ThinkingDiscoveryStrategy = typeof THINKING_DISCOVERY_STRATEGIES[number] | 'reasoning-effort-low' | 'bare-expanded';

/**
 * The nearest equivalent of a reference's setting, tried on a seller that refuses the setting itself, before the order
 * (`THINKING_DISCOVERY_RULE`): the whole table, kept small on purpose. `reasoning.effort: "low"` for `"minimal"` only: on
 * the genuine models whose reference was asked with `"minimal"`, `"low"` measured as the same request (FLIPS passes
 * against the `"minimal"` reference as often as a second `"minimal"` sample does, with the same billing and reasoning
 * tokens), while `"none"` can put a model in another way of answering. Never part of the order itself.
 */
export const THINKING_REFERENCE_EQUIVALENTS: Readonly<Partial<Record<ThinkingDiscoveryStrategy, ThinkingDiscoveryStrategy>>> = Object.freeze({
  'reasoning-effort-minimal': 'reasoning-effort-low',
});

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
    case 'reasoning-effort-low': return { overrides: { reasoning: { effort: 'low' } } };
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
  /**
   * Recorded only, never decided on: the reply carries reasoning text in a field of its own (`reasoning_content`,
   * `reasoning`, `thinking`), which some hosts send while itemising no reasoning tokens.
   */
  reasoningShown?: boolean;
  /** Recorded only: the output tokens the reply bills, beside its visible answers. */
  billedOutputTokens?: number;
  failure?: string;
}

export interface ThinkingDiscoveryResultV1 extends ThinkingStrategyRequest {
  strategy: ThinkingDiscoveryStrategy;
  attempts: ThinkingDiscoveryAttemptV1[];
}

/**
 * How discovery chooses, an Antseed addition to the KBF reference code. As in the reference code, the first strategy that
 * answers cleanly with no reasoning tokens wins, and `bare` is the baseline that may think. When none turns thinking off,
 * the strategy that answered cleanly with the fewest reasoning tokens is recorded instead of `bare`, if it thought less
 * than `bare` did (or `bare` failed): a setting that thinks a little is closer to the reference code's no-thinking answers
 * than one that thinks as long as it likes, and it leaves room for the answer. GLM 5.3 on its maker's endpoint reasoned
 * 70 tokens with `reasoning.effort: "minimal"` and 295 with nothing on the ten test questions, and with nothing it then
 * spent every token of real batches thinking and answered none.
 *
 * An audited endpoint is first asked with the reference's own setting (`referenceStrategy`: the one its bank's discovery
 * chose on the genuine endpoint), so it is asked the way the reference was wherever it can be: when that setting answers
 * cleanly with no reasoning tokens, it is the endpoint's setting. Otherwise the order above runs exactly as before, that
 * first attempt standing in its own place in the order instead of being sent again. Sonnet 5.5's reference route refuses
 * `reasoning.effort: "none"` and its bank recorded `"minimal"`; a seller that accepts both is asked with `"minimal"`, as
 * the reference was. A seller that refuses the reference's setting (an HTTP 4xx other than 429) is next asked with its
 * nearest equivalent, where the table has one (`THINKING_REFERENCE_EQUIVALENTS`: `"low"` for `"minimal"`), kept on the
 * same terms; only then does the order run, so such a seller never falls to `"none"` first. A bank without a stored
 * discovery has no reference setting, and discovery runs the order alone.
 * Part of the audit rules (the verifier compat fingerprint).
 */
export const THINKING_DISCOVERY_RULE = 'kbf-discovery-reference-first-v1' as const;

/**
 * Every discovery rule a stored discovery may have been made under, oldest first. `kbf-discovery-least-reasoning-v1` is
 * this rule without the reference's setting tried first: evidence made before has no `rule` and is read under it.
 */
export const THINKING_DISCOVERY_RULES = ['kbf-discovery-least-reasoning-v1', THINKING_DISCOVERY_RULE] as const;

export type ThinkingDiscoveryRuleId = typeof THINKING_DISCOVERY_RULES[number];

/** The rule a stored discovery without a `rule` was made under. */
export const THINKING_DISCOVERY_LEGACY_RULE: ThinkingDiscoveryRuleId = THINKING_DISCOVERY_RULES[0];

/**
 * Whether a strategy can be tried first as the reference's setting: one that sets something to turn thinking off, so not
 * `bare` (the baseline, already last in the order) nor `bare-expanded` or an older reference's strategy name.
 */
export function isReferenceFirstStrategy(strategy: unknown): strategy is Exclude<typeof THINKING_DISCOVERY_STRATEGIES[number], 'bare'> {
  return typeof strategy === 'string' && strategy !== 'bare' && (THINKING_DISCOVERY_STRATEGIES as readonly string[]).includes(strategy);
}

export type ThinkingDiscoveryProbe = (input: {
  strategy: ThinkingDiscoveryStrategy;
  request: ThinkingStrategyRequest;
  maxTokens: number;
}) => Promise<
  | { ok: true; content: string | null; reasoningTokens: number; truncated?: boolean; reasoningShown?: boolean; billedOutputTokens?: number }
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

/**
 * Whether an OpenAI-style response body carries reasoning text in a field of its own (`reasoning_content`, `reasoning`
 * or `thinking` on the first choice's message, non-empty): reasoning a host may send while itemising no reasoning tokens.
 */
export function reasoningShownInReply(responseBody: string): boolean {
  try {
    const parsed = JSON.parse(responseBody) as { choices?: Array<{ message?: Record<string, unknown> }> };
    const message = parsed.choices?.[0]?.message;
    if (!message || typeof message !== 'object') return false;
    return ['reasoning_content', 'reasoning', 'thinking'].some((key) => {
      const value = message[key];
      return (typeof value === 'string' && value.trim().length > 0) || (Array.isArray(value) && value.length > 0);
    });
  } catch {
    return false;
  }
}

/** `usage.completion_tokens` (or `output_tokens`) of a response body, a non-negative integer; undefined when absent. */
export function billedOutputTokensOf(responseBody: string): number | undefined {
  try {
    const parsed = JSON.parse(responseBody) as { usage?: { completion_tokens?: unknown; output_tokens?: unknown } };
    const tokens = parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens;
    return typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined;
  } catch {
    return undefined;
  }
}

/** Removes `<think>…</think>` blocks from an answer, as the reference code does before parsing a batch. */
export function stripKbfThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Whether a discovery attempt turned thinking off: enough answers, 0 reasoning tokens, only the answers, not cut off.
 * The one predicate: discovery decides with it, and a reader of a stored discovery (the verifier's audit, reading a
 * bank's attempts) reads with it, so the two never drift.
 */
export function thinkingAttemptReachedZero(
  attempt: Pick<ThinkingDiscoveryAttemptV1, 'validAnswers' | 'reasoningTokens' | 'answersOnly' | 'truncated'> | undefined,
): boolean {
  return attempt !== undefined
    && (attempt.validAnswers ?? -1) >= THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS && attempt.reasoningTokens === 0
    && attempt.answersOnly !== false && attempt.truncated !== true;
}

/** Whether the endpoint refused the setting: an HTTP 4xx other than 429, with no answer (a 429 or a 5xx is no refusal). */
function isRefusal(attempt: ThinkingDiscoveryAttemptV1): boolean {
  return attempt.validAnswers === null && attempt.status !== null && attempt.status >= 400 && attempt.status < 500 && attempt.status !== 429;
}

export async function discoverThinkingSuppression(input: {
  model: string;
  label: string;
  /** Prefill only applies to OpenAI Chat Completions, as in the reference code. */
  supportsPrefill: boolean;
  probe: ThinkingDiscoveryProbe;
  /**
   * The reference's setting, tried before the order (`THINKING_DISCOVERY_RULE`); null or absent for the reference itself
   * and for a bank without a stored discovery. Ignored unless `isReferenceFirstStrategy`, and a prefill without
   * `supportsPrefill`.
   */
  referenceStrategy?: ThinkingDiscoveryStrategy | null;
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
        // Recorded for the replay that decides whether shown reasoning should fail a strategy; not read below.
        ...(outcome.reasoningShown !== undefined ? { reasoningShown: outcome.reasoningShown } : {}),
        ...(outcome.billedOutputTokens !== undefined ? { billedOutputTokens: outcome.billedOutputTokens } : {}),
      }
      : { strategy, maxTokens, status: outcome.status, validAnswers: null, reasoningTokens: null, failure: outcome.failure };
    attempts.push(attempt);
    return attempt;
  };
  /** Strategies that answered cleanly but still thought, fewest reasoning tokens first (earlier strategies on a tie). */
  const thoughtAnyway: ThinkingDiscoveryAttemptV1[] = [];
  const leastOf = (than: number | null): ThinkingDiscoveryAttemptV1 | null => {
    const least = [...thoughtAnyway].sort((left, right) => (left.reasoningTokens ?? 0) - (right.reasoningTokens ?? 0))[0];
    return least && (than === null || (least.reasoningTokens ?? 0) < than) ? least : null;
  };
  const useLeast = (least: ThinkingDiscoveryAttemptV1, against: string): ThinkingDiscoveryResultV1 => {
    input.log?.(
      `thinking suppression for ${input.model}: nothing turns thinking off on ${input.label}; '${least.strategy}' thought least `
      + `(reasoning_tokens=${least.reasoningTokens}, ${against}), so it is used (${THINKING_DISCOVERY_RULE})`,
    );
    // Nothing marks the pick in the result: a stored setting is read as it is, and its attempts show why it was chosen.
    return { strategy: least.strategy, ...thinkingStrategyRequest(least.strategy), attempts };
  };
  // The reference's setting first: kept when it turns thinking off here too, else it stands in its own place below.
  const referenceFirst = isReferenceFirstStrategy(input.referenceStrategy) && (input.referenceStrategy !== 'prefill' || input.supportsPrefill)
    ? input.referenceStrategy
    : null;
  const referenceAttempt = referenceFirst ? await tryOnce(referenceFirst, THINKING_DISCOVERY_MAX_TOKENS) : null;
  if (referenceFirst && referenceAttempt) {
    if (thinkingAttemptReachedZero(referenceAttempt)) {
      input.log?.(
        `thinking suppression for ${input.model}: the reference's '${referenceFirst}' works on ${input.label} `
        + `(${referenceAttempt.validAnswers}/10 parseable, reasoning_tokens=0), so it is asked as the reference was`,
      );
      return { strategy: referenceFirst, ...thinkingStrategyRequest(referenceFirst), attempts };
    }
    // Refused outright: its nearest equivalent next, on the same terms, before the order can reach a setting further away.
    const equivalent = isRefusal(referenceAttempt) ? THINKING_REFERENCE_EQUIVALENTS[referenceFirst] : undefined;
    if (equivalent) {
      const equivalentAttempt = await tryOnce(equivalent, THINKING_DISCOVERY_MAX_TOKENS);
      if (thinkingAttemptReachedZero(equivalentAttempt)) {
        input.log?.(
          `thinking suppression for ${input.model}: ${input.label} refuses the reference's '${referenceFirst}' and its nearest `
          + `equivalent '${equivalent}' works (${equivalentAttempt.validAnswers}/10 parseable, reasoning_tokens=0), so it is used`,
        );
        return { strategy: equivalent, ...thinkingStrategyRequest(equivalent), attempts };
      }
    }
    input.log?.(`thinking suppression for ${input.model}: the reference's '${referenceFirst}' does not turn thinking off on ${input.label}; trying each setting in order`);
  }
  for (const strategy of THINKING_DISCOVERY_STRATEGIES) {
    if (strategy === 'prefill' && !input.supportsPrefill) continue;
    // The reference's setting was sent first: its answer is read here, in its own place, and not asked again.
    const attempt = strategy === referenceFirst && referenceAttempt ? referenceAttempt : await tryOnce(strategy, THINKING_DISCOVERY_MAX_TOKENS);
    const valid = attempt.validAnswers ?? -1;
    const cleanReply = attempt.answersOnly !== false && attempt.truncated !== true;
    // `bare` is the no-suppression baseline and may think; a strategy that thought less than it is used instead
    // (`THINKING_DISCOVERY_RULE`).
    if (strategy === 'bare' && valid >= THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS && cleanReply) {
      const least = leastOf(attempt.reasoningTokens ?? 0);
      if (least) return useLeast(least, `against ${attempt.reasoningTokens} with 'bare'`);
    }
    // Any other strategy that still reports reasoning tokens was accepted but ignored. A reply that reasons in the open
    // or stops at the token limit fails any strategy.
    if (valid >= THINKING_DISCOVERY_MINIMUM_VALID_ANSWERS && cleanReply && strategy !== 'bare' && (attempt.reasoningTokens ?? 0) > 0) {
      thoughtAnyway.push(attempt);
    }
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
  // `bare` did not answer cleanly: a strategy that answered cleanly while thinking a little is better than thinking freely
  // with fifty times the tokens.
  const least = leastOf(null);
  if (least) return useLeast(least, "'bare' did not answer cleanly");
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
