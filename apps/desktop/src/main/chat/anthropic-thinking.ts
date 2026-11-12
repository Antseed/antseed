/**
 * The `thinking` field the chat sends on an Anthropic Messages request.
 *
 * The chat's agent library (pi-ai) builds it as `{ type: "enabled",
 * budget_tokens }` for every model except the few it knows by name, and as
 * `{ type: "disabled" }` when thinking is off. Current Claude models return a
 * 400 for both. This module decides the field from the model id and the
 * seller's reasoning flag, and rewrites the request body before it is sent.
 *
 * Which Claude models take which form follows Anthropic's per-model thinking
 * table (platform.claude.com/docs/en/build-with-claude/thinking). Leaving
 * `thinking` out is accepted by every model, so a model this module does not
 * recognise gets no field at all.
 */

import type { ThinkingLevel as LibraryThinkingLevel } from '@mariozechner/pi-ai';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { splitPinnedModel } from '../../shared/pinned-model.js';

/** The chat session's thinking level (`ExtensionAPI.getThinkingLevel`). */
export type ThinkingLevel = 'off' | LibraryThinkingLevel;

/** pi-coding-agent's default level (`DEFAULT_THINKING_LEVEL`, not exported), used when settings name none. */
export const DEFAULT_CHAT_THINKING_LEVEL: ThinkingLevel = 'medium';

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
  mythos: { adaptive: [0, 0], xhigh: [0, 0], budget: [0, 0] },
} as const satisfies Record<string, { adaptive: Version; xhigh: Version; budget: Version }>;

type ClaudeFamily = keyof typeof THINKING_THRESHOLDS;

function isClaudeFamily(name: string | undefined): name is ClaudeFamily {
  return name !== undefined && Object.hasOwn(THINKING_THRESHOLDS, name);
}

// `claude-<family>-<major>[-<minor>]`, with any vendor prefix and any release
// date or `latest` after it. A date is not read as a version: it has more
// than two digits. Same shape as the seller-side Anthropic relay's matcher.
const CLAUDE_MODEL_RE = /claude[-._](opus|sonnet|haiku|fable|mythos)[-._](\d{1,2})(?:[-._](\d{1,2}))?(?!\d)/;
// Claude 3 ids name the version first: `claude-3-7-sonnet-20250219`, `claude-3-opus-latest`.
const VERSION_FIRST_CLAUDE_RE = /claude[-._](\d)(?:[-._](\d))?[-._](opus|sonnet|haiku)(?![a-z])/;

function claudeVersion(modelId: string): { family: ClaudeFamily; version: Version } | null {
  const id = splitPinnedModel(modelId).modelId.trim().toLowerCase();
  const match = CLAUDE_MODEL_RE.exec(id);
  if (match && isClaudeFamily(match[1])) return { family: match[1], version: [Number(match[2]), Number(match[3] ?? 0)] };
  const versionFirst = VERSION_FIRST_CLAUDE_RE.exec(id);
  if (versionFirst && isClaudeFamily(versionFirst[3])) {
    return { family: versionFirst[3], version: [Number(versionFirst[1]), Number(versionFirst[2] ?? 0)] };
  }
  return null;
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
 * its own and runs at `low`; `xhigh` drops to `high` on a model without it.
 */
export function anthropicEffort(level: ThinkingLevel, modelId: string): 'low' | 'medium' | 'high' | 'xhigh' {
  switch (level) {
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'xhigh': {
      const parsed = claudeVersion(modelId);
      return parsed && atLeast(parsed.version, THINKING_THRESHOLDS[parsed.family].xhigh) ? 'xhigh' : 'high';
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

/**
 * The request body with the thinking the model takes: none when the sellers
 * do not reason, thinking is off or the model is not recognised; adaptive
 * with an effort and summarized display; or the budget the library already set for an older model.
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
  if (mode === 'budget' && record(thinking)?.['type'] === 'enabled') {
    return { ...rest, thinking, ...keptConfig };
  }
  return { ...rest, ...keptConfig };
}

/** The pi extension hook: `before_provider_request` replaces the body with the shaped one. */
export function anthropicThinkingExtension(options: Omit<AnthropicThinkingOptions, 'level'>): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => shapeAnthropicThinking(event.payload, { ...options, level: pi.getThinkingLevel() }));
  };
}
