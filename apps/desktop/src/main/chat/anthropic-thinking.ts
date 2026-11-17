/**
 * The `thinking` field the chat sends on an Anthropic Messages request.
 *
 * The chat's agent library (pi-ai) builds it as `{ type: "enabled",
 * budget_tokens }` for every model except the few it knows by name, and as
 * `{ type: "disabled" }` when thinking is off. Current Claude models return a
 * 400 for both. This module decides the field from the model id and the
 * seller's reasoning flag, and rewrites the request body before it is sent,
 * in the stream function every Anthropic Messages request of the chat goes
 * through: its turns, and the summaries pi writes on its own (compaction).
 *
 * Which Claude models take which form follows Anthropic's per-model thinking
 * table (platform.claude.com/docs/en/build-with-claude/thinking). Leaving
 * `thinking` out is accepted by every model, so a model this module does not
 * recognise gets no field at all.
 */

import type { Model, SimpleStreamOptions, StreamFunction, ThinkingLevel as LibraryThinkingLevel } from '@mariozechner/pi-ai';
import { streamSimpleAnthropic } from '@mariozechner/pi-ai/anthropic';
import type { ModelRegistry } from '@mariozechner/pi-coding-agent';
import { splitPinnedModel } from '../../shared/pinned-model.js';

/** A request's thinking level: pi sends its level as the `reasoning` option, and none for `off`. */
export type ThinkingLevel = 'off' | LibraryThinkingLevel;

/**
 * A gateway model over Anthropic Messages. pi's own `reasoning` flag stays
 * true, so pi never lowers a chat's saved thinking level; whether to ask for
 * thinking is the sellers' flag, carried here to the stream function.
 */
export type AnthropicGatewayModel = Model<'anthropic-messages'> & {
  /** The sellers that can serve the request declare reasoning (`modelReasons`). */
  sellersReason: boolean;
};

/**
 * `adaptive` with `output_config.effort` and `display: "summarized"`, or
 * `budget`: `enabled` with `budget_tokens`. The adaptive models from Opus 4.7,
 * Sonnet 5 and Haiku 5.5 on default `display` to `omitted`, which returns
 * thinking blocks with empty text, so the chat asks for the summary it shows.
 * Older models already default to `summarized`.
 */
export type AnthropicThinkingMode = 'adaptive' | 'budget';

type Version = readonly [major: number, minor: number];

/**
 * The first version of each Claude family that takes each thinking form.
 *
 * - `adaptive`: takes `{ type: "adaptive" }`. Before it, a model takes only
 *   `{ type: "enabled", budget_tokens }` and returns a 400 for adaptive. From
 *   Opus 4.7, Sonnet 5 and Haiku 5.5 on, `enabled` returns a 400 (Opus 4.6
 *   and Sonnet 4.6 take both).
 * - `xhigh`: accepts effort `xhigh`; the adaptive models before it stop at
 *   `max` without `xhigh`.
 * - `budget`: takes `{ type: "enabled", budget_tokens }`. Claude 3.7 Sonnet
 *   was the first model with thinking; the other Claude 3 models have none.
 */
const THINKING_THRESHOLDS = {
  opus: { adaptive: [4, 6], xhigh: [4, 7], budget: [4, 0] },
  sonnet: { adaptive: [4, 6], xhigh: [5, 0], budget: [3, 7] },
  haiku: { adaptive: [5, 0], xhigh: [5, 0], budget: [4, 0] },
  fable: { adaptive: [0, 0], xhigh: [0, 0], budget: [0, 0] },
  // Mythos Preview (no version in its id, read as 0.0) is adaptive without `xhigh`.
  mythos: { adaptive: [0, 0], xhigh: [5, 0], budget: [0, 0] },
} as const satisfies Record<string, { adaptive: Version; xhigh: Version; budget: Version }>;

type ClaudeFamily = keyof typeof THINKING_THRESHOLDS;

function isClaudeFamily(name: string | undefined): name is ClaudeFamily {
  return name !== undefined && Object.hasOwn(THINKING_THRESHOLDS, name);
}

// An optional vendor prefix (`anthropic/`, `us.anthropic.`), then the Claude id
// from its start: an agent's own name that only contains one
// (`my-agent-claude-opus-4-7`) is not a Claude model.
const VENDOR_PREFIX = String.raw`^(?:[a-z0-9-]+[./])*`;
// `claude-<family>-<major>[-<minor>]`, with any release date or `latest` after
// it. A date is not read as a version: it has more than two digits, and
// neither is a size suffix such as `-32k`. Same rule as the seller-side
// Anthropic relay's matcher.
const CLAUDE_MODEL_RE = new RegExp(String.raw`${VENDOR_PREFIX}claude[-._](opus|sonnet|haiku|fable|mythos)[-._](\d{1,2})(?:[-._](\d{1,2}))?(?![\da-z])`);
// Claude 3 ids name the version first: `claude-3-7-sonnet-20250219`, `claude-3-opus-latest`.
const VERSION_FIRST_CLAUDE_RE = new RegExp(String.raw`${VENDOR_PREFIX}claude[-._](\d)(?:[-._](\d))?[-._](opus|sonnet|haiku)(?![a-z])`);
const MYTHOS_PREVIEW_RE = new RegExp(String.raw`${VENDOR_PREFIX}claude[-._]mythos[-._]preview(?![\da-z])`);

function claudeVersion(modelId: string): { family: ClaudeFamily; version: Version } | null {
  const id = splitPinnedModel(modelId).modelId.trim().toLowerCase();
  const match = CLAUDE_MODEL_RE.exec(id);
  if (match && isClaudeFamily(match[1])) return { family: match[1], version: [Number(match[2]), Number(match[3] ?? 0)] };
  const versionFirst = VERSION_FIRST_CLAUDE_RE.exec(id);
  if (versionFirst && isClaudeFamily(versionFirst[3])) {
    return { family: versionFirst[3], version: [Number(versionFirst[1]), Number(versionFirst[2] ?? 0)] };
  }
  return MYTHOS_PREVIEW_RE.test(id) ? { family: 'mythos', version: [0, 0] } : null;
}

function atLeast(version: Version, since: Version): boolean {
  return version[0] > since[0] || (version[0] === since[0] && version[1] >= since[1]);
}

/**
 * How this model takes thinking, or null when the id is not a versioned
 * Claude model (an agent's own name, another vendor's model, an unknown
 * release) or names a Claude model without thinking (Claude 3 before 3.7
 * Sonnet). The chat sends no `thinking` field for those.
 */
export function anthropicThinkingMode(modelId: string): AnthropicThinkingMode | null {
  const parsed = claudeVersion(modelId);
  if (!parsed) return null;
  const thresholds = THINKING_THRESHOLDS[parsed.family];
  if (atLeast(parsed.version, thresholds.adaptive)) return 'adaptive';
  return atLeast(parsed.version, thresholds.budget) ? 'budget' : null;
}

/**
 * The effort an adaptive model runs at for the chat's thinking level. The
 * levels below `xhigh` have the same name in both; `minimal` has no effort of
 * its own and runs at `low`. `xhigh` runs at `max` on Opus 4.6, which has
 * `max` but not `xhigh`, and drops to `high` on any other model without it.
 */
export function anthropicEffort(level: ThinkingLevel, modelId: string): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  switch (level) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'xhigh': {
      const parsed = claudeVersion(modelId);
      if (!parsed) return 'high';
      if (atLeast(parsed.version, THINKING_THRESHOLDS[parsed.family].xhigh)) return 'xhigh';
      return parsed.family === 'opus' && parsed.version[0] === 4 && parsed.version[1] === 6 ? 'max' : 'high';
    }
    default:
      return 'high';
  }
}

export type AnthropicThinkingOptions = {
  modelId: string;
  /** The sellers that can serve the request declare reasoning. */
  reasoning: boolean;
  level: ThinkingLevel;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** pi-ai's thinking budget per level (`adjustMaxTokensForThinking`), for a request it built in another form. */
const LEVEL_BUDGET_TOKENS: Record<LibraryThinkingLevel, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 16384 };
/** The API's minimum budget, and the room left for the answer when the budget has to shrink. */
const MIN_BUDGET_TOKENS = 1024;

/**
 * The `budget_tokens` for an older model: the budget pi-ai set, else the
 * level's, cut to leave room under `max_tokens`. Null when no budget of at
 * least 1024 tokens fits below `max_tokens`, which the API requires.
 */
function thinkingBudget(piThinking: Record<string, unknown> | null, level: LibraryThinkingLevel, maxTokens: unknown): number | null {
  if (typeof maxTokens !== 'number') return null;
  const piBudget = piThinking?.['type'] === 'enabled' && typeof piThinking['budget_tokens'] === 'number' ? piThinking['budget_tokens'] : null;
  const wanted = piBudget ?? LEVEL_BUDGET_TOKENS[level];
  const budget = wanted < maxTokens ? wanted : maxTokens - MIN_BUDGET_TOKENS;
  return budget >= MIN_BUDGET_TOKENS ? budget : null;
}

/**
 * The request body with the thinking the model takes: none when the sellers
 * do not reason, thinking is off or the model is not recognised; adaptive
 * with an effort and summarized display; or `enabled` with a budget for an
 * older model. The form pi-ai chose does not decide: it matches model ids
 * loosely (`claude-sonnet-4-64k` reads as Sonnet 4.6 to it).
 * Other fields are left as they are.
 */
export function shapeAnthropicThinking(payload: unknown, { modelId, reasoning, level }: AnthropicThinkingOptions): unknown {
  const body = record(payload);
  if (!body) return payload;
  const { thinking, output_config: outputConfig, ...rest } = body;
  const config = record(outputConfig);
  const { effort: _effort, ...otherConfig } = config ?? {};
  const keptConfig = Object.keys(otherConfig).length > 0 ? { output_config: otherConfig } : {};
  const mode = reasoning && level !== 'off' ? anthropicThinkingMode(modelId) : null;
  if (mode === 'adaptive') {
    return {
      ...rest,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { ...otherConfig, effort: anthropicEffort(level, modelId) },
    };
  }
  const budget = mode === 'budget' && level !== 'off' ? thinkingBudget(record(thinking), level, rest['max_tokens']) : null;
  return { ...rest, ...(budget === null ? {} : { thinking: { type: 'enabled', budget_tokens: budget } }), ...keptConfig };
}

/**
 * pi's Anthropic stream function with the request body shaped for the model.
 * A request's level is its `reasoning` option: the chat's level on a turn,
 * `high` on a compaction summary, none on a split-turn summary.
 */
export const streamGatewayAnthropic: StreamFunction<'anthropic-messages', SimpleStreamOptions> = (model, context, options) =>
  streamSimpleAnthropic(model, context, {
    ...options,
    onPayload: async (payload, payloadModel) => {
      const shaped = shapeAnthropicThinking(payload, {
        modelId: model.id,
        reasoning: (model as Partial<AnthropicGatewayModel>).sellersReason === true,
        level: options?.reasoning ?? 'off',
      });
      return (await options?.onPayload?.(shaped, payloadModel)) ?? shaped;
    },
  });

/**
 * Sends every Anthropic Messages request of this registry's sessions through
 * `streamGatewayAnthropic`. A session hook would miss the requests pi makes
 * outside a turn (compaction and branch summaries call the provider directly).
 */
export function registerGatewayAnthropic(modelRegistry: ModelRegistry, provider: string): void {
  modelRegistry.registerProvider(provider, {
    api: 'anthropic-messages',
    streamSimple: (model, context, options) => streamGatewayAnthropic(model as Model<'anthropic-messages'>, context, options),
  });
}
