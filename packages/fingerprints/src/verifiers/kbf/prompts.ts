/**
 * KBF prompt construction: numeric cloze batch prompts and
 * OpenAI-compatible chat request bodies.
 *
 * Audit requests rotate through a small fixed set of semantically equivalent
 * prompt variants so a seller cannot recognise audit traffic by a constant
 * system prompt or header and route only that traffic to the genuine model.
 * References pin the whole variant set (see `kbfPromptVariantsHash`); each
 * request picks one variant and records its id.
 */

import { canonicalHash } from '../../canonical-json.js';
import type { KbfProbe } from '../../types.js';

/**
 * Line-number formats. `parseKbfAnswers` accepts every format listed here
 * regardless of which one a request used.
 */
export type KbfLineFormat = 'paren' | 'dot' | 'close-paren' | 'q-colon';

export interface KbfPromptVariant {
  id: string;
  systemPrompt: string;
  /** Task description placed before the format rules. */
  task: string;
  lineFormat: KbfLineFormat;
}

export const KBF_PROMPT_VARIANTS: readonly KbfPromptVariant[] = Object.freeze(([
  {
    id: 'v1',
    systemPrompt: "Follow the user's instructions exactly. Output only what is requested.",
    task: 'TASK: Answer these factual recall questions using only values stored in your weights.',
    lineFormat: 'paren',
  },
  {
    id: 'v2',
    systemPrompt: 'You are a precise assistant. Reply with exactly the requested output and nothing else.',
    task: 'Fill in each blank below with the numeric value you recall from your training data.',
    lineFormat: 'dot',
  },
  {
    id: 'v3',
    systemPrompt: 'Answer concisely and follow the requested output format exactly.',
    task: 'Complete every statement below with the correct number from memory, without looking anything up.',
    lineFormat: 'close-paren',
  },
  {
    id: 'v4',
    systemPrompt: 'Respond only with the requested data. Do not add explanations.',
    task: 'Quiz: give the missing number in each of the following facts, based on your own knowledge.',
    lineFormat: 'q-colon',
  },
  {
    id: 'v5',
    systemPrompt: 'You are a helpful assistant. Keep answers short and strictly formatted.',
    task: 'For each item, supply the number that belongs in the blank. Use what you already know.',
    lineFormat: 'paren',
  },
  {
    id: 'v6',
    systemPrompt: 'Be exact. Output only the answers in the format the user specifies.',
    task: 'Recall the following numeric facts and provide the value that replaces ___ in each line.',
    lineFormat: 'dot',
  },
  {
    id: 'v7',
    systemPrompt: "Follow the instructions carefully and output nothing beyond what is asked.",
    task: 'Below are fill-in-the-blank facts. Answer each one with a number from memory.',
    lineFormat: 'close-paren',
  },
  {
    id: 'v8',
    systemPrompt: 'Provide terse, correctly formatted answers only.',
    task: 'Numeric recall check: state the value missing from each sentence using your existing knowledge.',
    lineFormat: 'q-colon',
  },
] satisfies KbfPromptVariant[]).map((variant) => Object.freeze(variant)));

export const KBF_DEFAULT_PROMPT_VARIANT_ID = 'v1';
export const KBF_PROMPT_VARIANT_IDS: readonly string[] = Object.freeze(
  KBF_PROMPT_VARIANTS.map((variant) => variant.id),
);

/** Content hash over the full variant set; pinned by reference query profiles. */
export function kbfPromptVariantsHash(): string {
  return canonicalHash(KBF_PROMPT_VARIANTS);
}

export function getKbfPromptVariant(variantId: string = KBF_DEFAULT_PROMPT_VARIANT_ID): KbfPromptVariant {
  const variant = KBF_PROMPT_VARIANTS.find((entry) => entry.id === variantId);
  if (!variant) throw new Error(`unknown KBF prompt variant "${variantId}"`);
  return variant;
}

function formatLineLabel(format: KbfLineFormat, index: number | 'N'): string {
  switch (format) {
    case 'paren': return `(${index})`;
    case 'dot': return `${index}.`;
    case 'close-paren': return `${index})`;
    case 'q-colon': return `Q${index}:`;
  }
}

function formatRules(format: KbfLineFormat): string {
  return `RULES: Output ONLY in ${formatLineLabel(format, 'N')} <number> format, one per line. ` +
    'Give a single plain number per line, no words, no ranges. ' +
    'If unsure, output your best single numeric estimate.';
}

/** Render a probe's cloze line, substituting `{name}` when present. */
export function renderKbfProbeLine(probe: KbfProbe): string {
  return probe.template.includes('{name}')
    ? probe.template.split('{name}').join(probe.name)
    : probe.template;
}

/**
 * Build the numeric cloze batch prompt for a variant:
 * task/RULES header followed by numbered `<label> <template with ___>` lines.
 * `batchIndexOffset` shifts numbering for multi-batch audits.
 */
export function buildKbfPrompt(
  probes: readonly KbfProbe[],
  batchIndexOffset = 0,
  variantId: string = KBF_DEFAULT_PROMPT_VARIANT_ID,
): string {
  const variant = getKbfPromptVariant(variantId);
  const lines = probes.map(
    (probe, i) => `${formatLineLabel(variant.lineFormat, batchIndexOffset + i + 1)} ${renderKbfProbeLine(probe)}`,
  );
  return `${variant.task}\n${formatRules(variant.lineFormat)}\n\n${lines.join('\n')}`;
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
  options: { batchIndexOffset?: number; maxTokens?: number; variantId?: string } = {},
): KbfChatRequestBody {
  const { batchIndexOffset = 0, maxTokens, variantId = KBF_DEFAULT_PROMPT_VARIANT_ID } = options;
  return {
    model,
    messages: [
      { role: 'system', content: getKbfPromptVariant(variantId).systemPrompt },
      { role: 'user', content: buildKbfPrompt(probes, batchIndexOffset, variantId) },
    ],
    temperature: 0,
    max_tokens: maxTokens ?? Math.min(800, Math.max(100, probes.length * 16)),
  };
}
