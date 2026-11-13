import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isKbfAnswersOnlyReply, parseKbfAnswers } from '../src/verifiers/kbf/parser.js';
import { KBF_PROMPT_VARIANTS, buildKbfPrompt, isKbfSamplingFieldRejection } from '../src/verifiers/kbf/prompts.js';
import type { KbfProbe } from '../src/types.js';

/** Real replies from one glm-5.3 seller (via DeepInfra) in the epoch 29 audits, anonymized. */
const glmReplies = JSON.parse(readFileSync(new URL('./fixtures/glm-deepinfra-replies.json', import.meta.url), 'utf8')) as Record<
  'reasonedCutOff' | 'reasonedComplete' | 'minimalClean',
  { finishReason: string; content: string; parsedBefore: Array<number | null> }
>;

describe('parseKbfAnswers', () => {
  it('parses well-formed (N) <number> lines', () => {
    const text = '(1) 3880\n(2) 46\n(3) 299792.458';
    expect(parseKbfAnswers(text, 3)).toEqual([3880, 46, 299792.458]);
  });

  it('is position-aware: (N) index wins over line order', () => {
    const text = '(3) 30\n(1) 10';
    expect(parseKbfAnswers(text, 3)).toEqual([10, null, 30]);
  });

  it('tolerates messy whitespace and separators', () => {
    const text = '  ( 1 )   3880  \n\t(2):\t46\n 3.  1234 \n4)  55';
    expect(parseKbfAnswers(text, 4)).toEqual([3880, 46, 1234, 55]);
  });

  it('reads index-less <number>…</number> lines in order when there is one per probe', () => {
    expect(parseKbfAnswers('<number>2350</number>\n<number>100</number>\n<number>-73.5</number>', 3)).toEqual([2350, 100, -73.5]);
    // Not one line per probe: positions are unknown, so nothing is guessed.
    expect(parseKbfAnswers('<number>2350</number>\n<number>100</number>', 3)).toEqual([null, null, null]);
    // Indexed lines still win.
    expect(parseKbfAnswers('2) <number>5</number>\n1) <number>4</number>', 2)).toEqual([4, 5]);
  });

  it('handles commas in numbers', () => {
    expect(parseKbfAnswers('(1) 384,400', 1)).toEqual([384400]);
    expect(parseKbfAnswers('(1) 1,234,567.89', 1)).toEqual([1234567.89]);
  });

  it('handles scientific notation', () => {
    expect(parseKbfAnswers('(1) 3.88e3\n(2) 1.6E-19', 2)).toEqual([3880, 1.6e-19]);
  });

  it('handles trailing units and prose around the number', () => {
    const text = '(1) 3880°C\n(2) approximately 46 chromosomes\n(3) 687 days';
    expect(parseKbfAnswers(text, 3)).toEqual([3880, 46, 687]);
  });

  it('preserves negative answers, including with no space after the index', () => {
    expect(parseKbfAnswers('(1) -430\n(2)-273.15', 2)).toEqual([-430, -273.15]);
  });

  it('returns null for missing positions', () => {
    expect(parseKbfAnswers('(1) 5\n(3) 7', 4)).toEqual([5, null, 7, null]);
  });

  it('returns null for unparseable lines', () => {
    expect(parseKbfAnswers('(1) unknown\n(2) 42', 2)).toEqual([null, 42]);
  });

  it('ignores extra prose lines and out-of-range indices', () => {
    const text = [
      'Sure! Here are the answers:',
      '(1) 100',
      'Note that 1990 was a different value.',
      '(9) 900',
      '(2) 200',
      'Hope this helps!',
    ].join('\n');
    expect(parseKbfAnswers(text, 2)).toEqual([100, 200]);
  });

  it('keeps the later line when an index repeats, as the KBF reference code does', () => {
    expect(parseKbfAnswers('(1) 10\n(1) 20', 1)).toEqual([20]);
  });

  it('reads the last number of a line, the answer a reasoning line ends with', () => {
    expect(parseKbfAnswers('2) It ran from May 1923 to July 1924. It published 52 issues.', 2)).toEqual([null, 52]);
    expect(parseKbfAnswers('(1) 3880\n(2) approximately 46 chromosomes', 2)).toEqual([3880, 46]);
  });

  it('reads the answers GLM-5.3 on DeepInfra gives when it reasons in its reply', () => {
    // The first number of each line was the question's own wording (589 nm) or a figure the
    // model was weighing; the last is the value it settled on ("Let me say 1.56.").
    const answers = parseKbfAnswers(glmReplies.reasonedComplete.content, 6);
    expect(glmReplies.reasonedComplete.parsedBefore.slice(0, 5)).toEqual([589, 0, 200, 5, 633]);
    expect(answers.slice(0, 5)).toEqual([1.56, 510000, 200000000, 0.9, 134]);
  });

  it('handles empty input and zero probe count', () => {
    expect(parseKbfAnswers('', 3)).toEqual([null, null, null]);
    expect(parseKbfAnswers('(1) 5', 0)).toEqual([]);
  });

  it('parses every line-number format emitted by the prompt variants', () => {
    expect(parseKbfAnswers('1. 3880\n2. -46\n3. 299792.458', 3)).toEqual([3880, -46, 299792.458]);
    expect(parseKbfAnswers('1) 3880\n2) -46\n3) 1.5', 3)).toEqual([3880, -46, 1.5]);
    expect(parseKbfAnswers('Q1: 3880\nQ2: -46\nq3: 7', 3)).toEqual([3880, -46, 7]);
    expect(parseKbfAnswers('Q 1: 3880\nQ 2:-46', 2)).toEqual([3880, -46]);
  });

  it('does not treat prose starting with Q as an answer line', () => {
    expect(parseKbfAnswers('Quiz answers:\nQ1: 5', 1)).toEqual([5]);
  });

  it('round-trips answers echoed in each variant line format', () => {
    const probes: KbfProbe[] = [1, 2, 3].map((index) => ({
      id: `p-${index}`,
      name: `p-${index}`,
      domain: 'test',
      template: `Probe ${index} is ___.`,
      consensus: index,
      range: [0, 10],
      tolerance: { mode: 'absolute', value: 0 },
    }));
    for (const variant of KBF_PROMPT_VARIANTS) {
      const labels = buildKbfPrompt(probes, 0, variant.id)
        .split('\n')
        .filter((line) => line.endsWith('is ___.'))
        .map((line) => line.slice(0, line.indexOf(' Probe')));
      expect(labels).toHaveLength(3);
      const response = labels.map((label, index) => `${label} ${(index + 1) * 11}`).join('\n');
      expect(parseKbfAnswers(response, 3)).toEqual([11, 22, 33]);
    }
  });
});

describe('isKbfSamplingFieldRejection', () => {
  it('matches errors saying the endpoint does not take temperature/top_p at all', () => {
    expect(isKbfSamplingFieldRejection(400, '{"error":{"message":"`temperature` is deprecated for this model."}}')).toBe(true);
    expect(isKbfSamplingFieldRejection(400, 'Unsupported parameter: \'top_p\' is not supported with this model.')).toBe(true);
    expect(isKbfSamplingFieldRejection(422, 'temperature: Extra inputs are not permitted')).toBe(true);
    expect(isKbfSamplingFieldRejection(400, 'Parameter "temperature" was rejected. Correct or remove it and submit a new request.')).toBe(true);
  });

  it('keeps fixed-value demands, other fields and non-4xx statuses out', () => {
    expect(isKbfSamplingFieldRejection(400, 'invalid temperature: only 0.6 is allowed for this model')).toBe(false);
    expect(isKbfSamplingFieldRejection(400, 'Validation: Kimi request field top_p must be one of: 0.95')).toBe(false);
    expect(isKbfSamplingFieldRejection(400, 'unsupported Chat feature for Claude Messages: n')).toBe(false);
    expect(isKbfSamplingFieldRejection(500, '`temperature` is deprecated for this model.')).toBe(false);
  });
});

describe('isKbfThinkingSuppressionRejection', () => {
  it('recognises refused reasoning, thinking and prefill fields', async () => {
    const { isKbfThinkingSuppressionRejection } = await import('../src/verifiers/kbf/prompts.js');
    expect(isKbfThinkingSuppressionRejection(400, 'Reasoning is mandatory for this endpoint and cannot be disabled.')).toBe(true);
    expect(isKbfThinkingSuppressionRejection(400, 'unsupported chat feature for claude messages: reasoning')).toBe(true);
    expect(isKbfThinkingSuppressionRejection(400, 'This model does not support assistant message prefill.')).toBe(true);
    expect(isKbfThinkingSuppressionRejection(422, 'enable_thinking: Extra inputs are not permitted')).toBe(true);
    expect(isKbfThinkingSuppressionRejection(400, '`temperature` is deprecated for this model.')).toBe(false);
    expect(isKbfThinkingSuppressionRejection(500, 'reasoning is not supported')).toBe(false);
  });
});

describe('kbfTargetThinkingSuppression', () => {
  it('keeps only the suppression fields and prefill of the reference request', async () => {
    const { kbfTargetThinkingSuppression } = await import('../src/verifiers/kbf/reference.js');
    const base = { queryProfile: {} as never };
    expect(kbfTargetThinkingSuppression({ ...base, generator: { name: 'x', version: '1', verifierKind: 'kbf', params: {
      referenceEndpointRequest: { reasoningStrategy: 'disable-thinking', requestOverrides: { thinking: { type: 'disabled' }, provider: {} }, requestOmissions: ['top_p'] },
    } } })).toEqual({ strategy: 'disable-thinking', overrides: { thinking: { type: 'disabled' } } });
    expect(kbfTargetThinkingSuppression({ ...base, generator: { name: 'x', version: '1', verifierKind: 'kbf', params: {
      referenceEndpointRequest: { reasoningStrategy: 'bare', requestOverrides: {}, requestOmissions: [] },
    } } })).toBeNull();
  });
});

describe('parseKbfAnswers unit numbers', () => {
  it('does not take a unit exponent or a digit glued to a unit as the answer', () => {
    expect(parseKbfAnswers('1) 9.81 m/s^2\n2) 1.6 m^3\n3) 340 m s^-1\n4) 415 ppm CO2\n5) 0.5 s-1', 5)).toEqual([9.81, 1.6, 340, 415, 0.5]);
  });

  it('reads written-out scientific notation as one number', () => {
    expect(parseKbfAnswers('1) 3.2 × 10^5\n2) 6.02x10^23\n3) 1.6 * 10^-19 C\n4) 12.5 x 10**3', 4)).toEqual([320000, 6.02e23, 1.6e-19, 12500]);
  });

  it('skips braced and bracketed unit exponents (LaTeX style)', () => {
    expect(parseKbfAnswers('1) 9.81 m/s^{2}\n2) 340 m s^{-1}\n3) 1.6 m^{ 3 }\n4) 2 m**(2)', 4)).toEqual([9.81, 340, 1.6, 2]);
  });

  it('reads braced scientific notation as one number', () => {
    expect(parseKbfAnswers('1) 6.02 \\times 10^{23}\n2) 1.6 \\cdot 10^{-19} C\n3) 3.0 · 10^{8} m/s', 3)).toEqual([6.02e23, 1.6e-19, 3e8]);
  });

  it('still takes the last number of a reasoned line and keeps signs and plain units', () => {
    expect(parseKbfAnswers('1) ran from 1923 to 1924, so 52\n2) -430\n3) 1,234 km\n4) 2.5e3', 4)).toEqual([52, -430, 1234, 2500]);
  });
});

describe('isKbfAnswersOnlyReply', () => {
  it('accepts numbered answers with short units and one heading line', () => {
    expect(isKbfAnswersOnlyReply('1) 78.37\n2) 79')).toBe(true);
    expect(isKbfAnswersOnlyReply('Here are the answers:\n(1) 9.81 m/s^2\n(2) 2.998 × 10^8 m/s\n(3) 1538 °C')).toBe(true);
    expect(isKbfAnswersOnlyReply('```\n1) <number>5</number>\n2) 6\n```')).toBe(true);
    expect(isKbfAnswersOnlyReply(glmReplies.minimalClean.content)).toBe(true);
  });

  it('rejects a reply that reasons, whether it finished or stopped at the token limit', () => {
    expect(isKbfAnswersOnlyReply(glmReplies.reasonedComplete.content)).toBe(false);
    expect(isKbfAnswersOnlyReply(glmReplies.reasonedCutOff.content)).toBe(false);
    expect(isKbfAnswersOnlyReply('Let me think.\nThe first one is easy.\n1) 5')).toBe(false);
    expect(isKbfAnswersOnlyReply('1) Shenghuo Weekly was founded by Huang Yanpei in 1925')).toBe(false);
  });
});
