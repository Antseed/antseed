/**
 * KBF prompt construction: numeric cloze batch prompts and
 * OpenAI-compatible chat request bodies.
 */

import type { KbfProbe } from '../../types.js';

export const KBF_SYSTEM_PROMPT =
  "Follow the user's instructions exactly. Output only what is requested.";

const KBF_TASK_HEADER =
  'TASK: Answer these factual recall questions using only values stored in your weights.\n' +
  'RULES: Output ONLY in (N) <number> format, one per line. ' +
  'Give a single plain number per line, no words, no ranges. ' +
  'If unsure, output your best single numeric estimate.';

/** Render a probe's cloze line, substituting `{name}` when present. */
export function renderKbfProbeLine(probe: KbfProbe): string {
  return probe.template.includes('{name}')
    ? probe.template.split('{name}').join(probe.name)
    : probe.template;
}

/**
 * Build the numeric cloze batch prompt:
 * TASK/RULES header followed by numbered `(N) <template with ___>` lines.
 * `batchIndexOffset` shifts numbering for multi-batch audits.
 */
export function buildKbfPrompt(probes: readonly KbfProbe[], batchIndexOffset = 0): string {
  const lines = probes.map(
    (probe, i) => `(${batchIndexOffset + i + 1}) ${renderKbfProbeLine(probe)}`,
  );
  return `${KBF_TASK_HEADER}\n\n${lines.join('\n')}`;
}

export interface KbfChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface KbfChatRequestBody {
  model: string;
  messages: KbfChatMessage[];
  temperature: number;
  max_tokens: number;
}

/**
 * Build an OpenAI-compatible chat.completions request body for a probe batch.
 * Transport-agnostic: actually sending it belongs to @antseed/node.
 */
export function buildKbfChatRequestBody(
  model: string,
  probes: readonly KbfProbe[],
  options: { batchIndexOffset?: number; maxTokens?: number } = {},
): KbfChatRequestBody {
  const { batchIndexOffset = 0, maxTokens } = options;
  return {
    model,
    messages: [
      { role: 'system', content: KBF_SYSTEM_PROMPT },
      { role: 'user', content: buildKbfPrompt(probes, batchIndexOffset) },
    ],
    temperature: 0,
    max_tokens: maxTokens ?? Math.min(800, Math.max(100, probes.length * 16)),
  };
}
