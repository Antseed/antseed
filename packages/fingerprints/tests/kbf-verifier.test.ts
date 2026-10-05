import { describe, expect, it } from 'vitest';
import {
  buildKbfChatRequestBody,
  buildKbfPrompt,
  parseKbfAnswers,
  verifyKbf,
} from '../src/verifiers/kbf/index.js';
import { canonicalHash } from '../src/canonical-json.js';
import type { FingerprintObservation, FingerprintReference, KbfProbe } from '../src/types.js';

const PROBES: KbfProbe[] = Array.from({ length: 20 }, (_, index) => ({
  id: `probe-${index + 1}`,
  name: `Probe ${index + 1}`,
  domain: 'test',
  template: `The test value is ___.`,
  consensus: index + 10,
  range: [0, 100],
  tolerance: { mode: 'absolute', value: 0.1 },
}));

function makeReference(overrides: Partial<FingerprintReference> = {}): FingerprintReference {
  const outcomes = PROBES.map((probe) => ({
    probeId: probe.id,
    answer: probe.consensus,
    match: 1 as const,
  }));
  return {
    version: 1,
    kind: 'kbf',
    referenceId: 'sha256:test-reference',
    referenceModel: 'openai/gpt-5.4',
    serviceAliases: ['gpt-5.4'],
    createdAt: '2026-06-14T00:00:00.000Z',
    source: 'generated',
    generator: {
      name: '@antseed/fingerprints',
      version: '0.1.0',
      verifierKind: 'kbf',
      params: {},
    },
    selfTest: { hamming: 0, total: PROBES.length, coverage: 1, errorRate: 0, outcomes },
    probes: PROBES,
    ...overrides,
  };
}

function makeObservation(answers: Array<number | null>): FingerprintObservation {
  return { answers };
}

describe('buildKbfPrompt', () => {
  it('emits the TASK/RULES header and numbered cloze lines', () => {
    const prompt = buildKbfPrompt(PROBES.slice(0, 3));
    expect(prompt).toMatch(/^TASK: /);
    expect(prompt).toContain('RULES: Output ONLY in (N) <number> format');
    expect(prompt).toContain('(1) ');
    expect(prompt).toContain('(2) ');
    expect(prompt).toContain('(3) ');
    expect(prompt).toContain('___');
    expect(prompt).not.toContain('{name}');
  });

  it('applies the batch index offset', () => {
    const prompt = buildKbfPrompt(PROBES.slice(0, 2), 10);
    expect(prompt).toContain('(11) ');
    expect(prompt).toContain('(12) ');
    expect(prompt).not.toContain('(1) ');
  });
});

describe('buildKbfChatRequestBody', () => {
  it('builds an OpenAI-compatible chat.completions body', () => {
    const body = buildKbfChatRequestBody('gpt-5.4', PROBES.slice(0, 10));
    expect(body.model).toBe('gpt-5.4');
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[1]!.role).toBe('user');
    expect(body.messages[1]!.content).toContain('TASK:');
    expect(JSON.parse(JSON.stringify(body))).toEqual(body); // plain JSON
  });
});

describe('verifyKbf', () => {
  it('round-trips: prompt -> simulated response -> parse -> SAME', () => {
    const reference = makeReference();
    const responseText = PROBES.map((p, i) => `(${i + 1}) ${p.consensus}`).join('\n');
    const answers = parseKbfAnswers(responseText, PROBES.length);
    const fragment = verifyKbf(reference, makeObservation(answers));
    expect(fragment.verdict).toBe('SAME');
    expect(fragment.parsedProbeCount).toBe(PROBES.length);
    expect(fragment.stats.targetHamming).toBe(0);
    expect(fragment.matchVectorHash).toBe(canonicalHash(fragment.matchVector));
  });

  it('flags a substitute answering differently as DIFF', () => {
    const reference = makeReference();
    // Answer far outside tolerance but inside range for every probe.
    const answers = PROBES.map((p) => {
      const [lo, hi] = p.range;
      const wrong = p.consensus + Math.max((hi - lo) * 0.2, p.tolerance.value * 50 + 1);
      return Math.min(wrong, hi);
    });
    const fragment = verifyKbf(reference, makeObservation(answers));
    expect(fragment.verdict).toBe('DIFF');
    expect(fragment.stats.pValueBinomial!).toBeLessThan(0.05);
  });

  it('counts missing answers from a completed response as discrepancies', () => {
    const reference = makeReference();
    const answers = PROBES.map((p, i) => (i < 5 ? p.consensus : null));
    const fragment = verifyKbf(reference, makeObservation(answers));
    expect(fragment.verdict).toBe('DIFF');
    expect(fragment.parsedProbeCount).toBe(PROBES.length);
    expect(fragment.stats.targetHamming).toBe(15);
    expect(fragment.stats.targetTotal).toBe(PROBES.length);
  });

  it('uses the full denominator when a completed response omits 49 of 100 answers', () => {
    const probes: KbfProbe[] = Array.from({ length: 100 }, (_, index) => ({
      ...PROBES[index % PROBES.length]!,
      id: `fixed-denominator-${index + 1}`,
      consensus: index + 1,
    }));
    const outcomes = probes.map((probe) => ({
      probeId: probe.id,
      answer: probe.consensus,
      match: 1 as const,
    }));
    const reference = makeReference({
      probes,
      selfTest: { hamming: 0, total: probes.length, coverage: 1, errorRate: 0, outcomes },
    });
    const answers = probes.map((probe, index) => (index < 51 ? probe.consensus : null));

    const fragment = verifyKbf(reference, makeObservation(answers));

    expect(fragment.verdict).toBe('DIFF');
    expect(fragment.parsedProbeCount).toBe(100);
    expect(fragment.stats.targetHamming).toBe(49);
    expect(fragment.stats.targetTotal).toBe(100);
    expect(fragment.stats.pValueBinomial).toBeLessThan(0.05);
  });

  it('returns UNDETERMINED for transport-unavailable probes', () => {
    const reference = makeReference();
    const fragment = verifyKbf(reference, {
      answers: PROBES.map(() => null),
      matchVector: PROBES.map((_, i) => (i < 5 ? 1 : null)),
    });
    expect(fragment.verdict).toBe('UNDETERMINED');
  });

  it('returns UNKNOWN for a non-kbf reference', () => {
    const reference = makeReference({ kind: 'behavioral-classifier' });
    const fragment = verifyKbf(reference, makeObservation(PROBES.map((p) => p.consensus)));
    expect(fragment.verdict).toBe('UNKNOWN');
    expect(fragment.verdictReason).toMatch(/kind/);
  });

  it('returns UNKNOWN for an invalid self-test', () => {
    const reference = makeReference({
      selfTest: { hamming: 0, total: 0, coverage: 0, errorRate: 0, outcomes: [] },
    });
    const fragment = verifyKbf(reference, makeObservation(PROBES.map((p) => p.consensus)));
    expect(fragment.verdict).toBe('UNKNOWN');
  });

  it('returns UNKNOWN on answer-count mismatch', () => {
    const reference = makeReference();
    const fragment = verifyKbf(reference, makeObservation([1, 2, 3]));
    expect(fragment.verdict).toBe('UNKNOWN');
    expect(fragment.verdictReason).toMatch(/length/);
  });

  it('uses a precomputed matchVector when provided', () => {
    const reference = makeReference();
    const observation: FingerprintObservation = {
      ...makeObservation([]),
      matchVector: PROBES.map(() => 1 as const),
    };
    const fragment = verifyKbf(reference, observation);
    expect(fragment.verdict).toBe('SAME');
    expect(fragment.stats.targetHamming).toBe(0);
  });

  it('returns UNKNOWN when a supplied matchVector holds entries other than 0/1/null', () => {
    const reference = makeReference();
    const invalidVectors = [
      PROBES.map((_, i) => (i === 0 ? 2 : 1)), // 2 is not a match
      PROBES.map((_, i) => (i === 0 ? true : 1)), // truthy boolean
      PROBES.map((_, i) => (i === 0 ? '1' : 1)), // string digit
      PROBES.map((_, i) => (i === 0 ? undefined : 1)), // hole
    ];
    for (const matchVector of invalidVectors) {
      const observation = {
        ...makeObservation([]),
        matchVector,
      } as unknown as FingerprintObservation;
      const fragment = verifyKbf(reference, observation);
      expect(fragment.verdict).toBe('UNKNOWN');
      expect(fragment.verdictReason).toMatch(/exactly 0, 1, or null/);
    }
  });
});
