import { describe, expect, it } from 'vitest';
import {
  assertMatchingQueryProfile,
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  kbfPromptVariantsHash,
  queryProfileHash,
  referenceCompatibilityProfileHash,
  referenceEndpointRequest,
  subsetReferenceSelfTest,
  validateKbfReferenceV1,
  type KbfReferenceV1,
} from '../src/index.js';

const RUNS = 3;

function reference(source: KbfReferenceV1['source'] = 'generated'): KbfReferenceV1 {
  const probes = Array.from({ length: 100 }, (_unused, index) => ({
    id: `p-${index}`,
    name: `probe-${index}`,
    domain: 'test',
    template: `Probe ${index} is ___.`,
    consensus: index,
    range: [0, 1_000] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 0.1 },
    advisoryConsensus: false,
  }));
  const outcomes = probes.map((probe) => ({
    probeId: probe.id,
    answers: Array.from({ length: RUNS }, () => probe.consensus),
    matches: Array.from({ length: RUNS }, () => 1 as const),
  }));
  const powerEvidence = computeBinomialPower({
    selfHamming: 0,
    selfTotal: probes.length * RUNS,
    probeCount: probes.length,
    minimumMismatchDelta: 0.1,
  });
  const value: KbfReferenceV1 = {
    version: 2,
    kind: 'kbf',
    referenceId: '',
    referenceModel: 'gpt-5.6-sol',
    serviceAliases: ['gpt-5.6-sol'],
    createdAt: '2026-07-31T12:00:00.000Z',
    source,
    generator: {
      name: 'test',
      version: '1',
      verifierKind: 'kbf',
      params: {},
    },
    queryProfile: createReferenceQueryProfile({ upstreamModel: 'gpt-5.6-sol-upstream' }),
    selfTest: {
      hamming: 0,
      total: probes.length * RUNS,
      coverage: 1,
      errorRate: 0,
      outcomes,
    },
    probes,
    selectedProbeCount: 100,
    minimumMismatchDelta: 0.1,
    statisticalPower: powerEvidence.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: 0,
      selfTotal: probes.length * RUNS,
      probeCount: probes.length,
      p0UpperBound: powerEvidence.p0,
      alternativeMismatchRate: powerEvidence.p1,
      criticalMismatchCount: powerEvidence.criticalMismatchCount,
      power: powerEvidence.power,
    },
    contrasts: [{
      model: 'contrast-model',
      distinguishingProbeIds: probes.slice(0, 40).map((probe) => probe.id),
    }],
  };
  value.referenceId = computeReferenceId(value);
  return value;
}

describe('ReferenceQueryProfileV1', () => {
  it('binds every frozen execution setting into the profile hash', () => {
    const profile = createReferenceQueryProfile({
      upstreamModel: 'gpt-5.6-sol-upstream',
      maxTokensPerRequest: 200,
      requestTimeoutMs: 45_000,
    });
    expect(profile).toMatchObject({
      apiProtocol: 'openai-chat-completions',
      enrollmentTemperatures: [0, 0.7, 0.7],
      selfTestTemperature: 0,
      contrastTemperature: 0,
      auditTemperature: 0,
      probesPerRequest: 10,
      maxTokensPerRequest: 200,
      requestTimeoutMs: 45_000,
      generationSettings: { topP: 1, seed: null, responseFormat: 'text' },
    });
    const changed = { ...profile, requestTimeoutMs: 45_001 };
    expect(queryProfileHash(changed)).not.toBe(queryProfileHash(profile));
    expect(() => assertMatchingQueryProfile(profile, changed)).toThrow(/profile mismatch/);
    expect(() => assertMatchingQueryProfile(profile, structuredClone(profile))).not.toThrow();

    const omitted = { ...profile, requestOmissions: ['temperature'] as const };
    expect(queryProfileHash(omitted)).not.toBe(queryProfileHash(profile));
    expect(() => assertMatchingQueryProfile(profile, omitted)).toThrow(/profile mismatch/);
  });
});

describe('subsetReferenceSelfTest', () => {
  it('pools every run of the exact selected subset', () => {
    const value = reference();
    value.selfTest.outcomes[2] = { probeId: 'p-2', answers: [999, 2, 2], matches: [0, 1, 1] };
    value.selfTest.outcomes[3] = { probeId: 'p-3', answers: [null, 3, 999], matches: [0, 1, 0] };
    const subset = subsetReferenceSelfTest(value, ['p-0', 'p-2', 'p-3']);
    expect(subset).toMatchObject({ hamming: 3, total: 9, coverage: 8 / 9, errorRate: 3 / 9 });
    expect(subset.outcomes.map((outcome) => outcome.probeId)).toEqual(['p-0', 'p-2', 'p-3']);
  });

  it('excludes unattempted trials from both hamming and total, like target scoring', () => {
    const value = reference();
    value.selfTest.outcomes[1] = { probeId: 'p-1', answers: [null, null, 1], matches: [null, 0, 1] };
    const subset = subsetReferenceSelfTest(value, ['p-0', 'p-1']);
    expect(subset).toMatchObject({ hamming: 1, total: 5, coverage: 4 / 6, errorRate: 1 / 5 });
  });
});

describe('validateKbfReferenceV1', () => {
  it('accepts a complete, internally consistent generated reference', () => {
    const value = reference();
    expect(validateKbfReferenceV1(value)).toEqual(value);
  });

  it('validates standard request omissions', () => {
    const valid = reference();
    valid.queryProfile.requestOmissions = ['temperature', 'top_p'];
    valid.referenceId = computeReferenceId(valid);
    expect(() => validateKbfReferenceV1(valid)).not.toThrow();

    const unsupported = reference();
    unsupported.queryProfile.requestOmissions = ['frequency_penalty' as 'temperature'];
    unsupported.referenceId = computeReferenceId(unsupported);
    expect(() => validateKbfReferenceV1(unsupported)).toThrow(/unsupported request omissions/);

    const duplicate = reference();
    duplicate.queryProfile.requestOmissions = ['temperature', 'temperature'];
    duplicate.referenceId = computeReferenceId(duplicate);
    expect(() => validateKbfReferenceV1(duplicate)).toThrow(/unsupported request omissions/);
  });

  it('pins the prompt variant set and rejects version 1 references', () => {
    const value = reference();
    expect(value.queryProfile.promptVariantsHash).toBe(kbfPromptVariantsHash());

    const tampered = reference();
    tampered.queryProfile.promptVariantsHash = 'sha256:' + '00'.repeat(32);
    tampered.referenceId = computeReferenceId(tampered);
    expect(() => validateKbfReferenceV1(tampered)).toThrow(/prompt variants hash mismatch/);

    const legacy = reference() as unknown as Record<string, unknown>;
    legacy.version = 1;
    legacy.referenceId = computeReferenceId(legacy);
    expect(() => validateKbfReferenceV1(legacy)).toThrow(/schema version 2/);
  });

  it('validates reference-endpoint settings recorded outside the query profile', () => {
    const settings = {
      reasoningStrategy: 'bare' as const,
      requestOverrides: {},
      requestOmissions: ['temperature' as const, 'top_p' as const],
    };
    const recorded = reference();
    recorded.generator.params.referenceEndpointRequest = settings;
    recorded.referenceId = computeReferenceId(recorded);
    expect(() => validateKbfReferenceV1(recorded)).not.toThrow();
    expect(referenceEndpointRequest(recorded)).toEqual(settings);

    const legacy = reference();
    Object.assign(legacy.queryProfile, settings);
    legacy.referenceId = computeReferenceId(legacy);
    expect(referenceEndpointRequest(legacy)).toEqual(settings);
    // Splitting the settings out of the profile keeps enrollment compatibility.
    expect(referenceCompatibilityProfileHash(recorded)).toBe(queryProfileHash(legacy.queryProfile));
    expect(referenceCompatibilityProfileHash(recorded)).not.toBe(queryProfileHash(recorded.queryProfile));
    expect(referenceEndpointRequest(reference())).toBeNull();

    const both = reference();
    both.generator.params.referenceEndpointRequest = settings;
    both.queryProfile.requestOmissions = ['temperature'];
    both.referenceId = computeReferenceId(both);
    expect(() => validateKbfReferenceV1(both)).toThrow(/must not also appear in the query profile/);

    const incomplete = reference();
    incomplete.generator.params.referenceEndpointRequest = { reasoningStrategy: 'bare' };
    incomplete.referenceId = computeReferenceId(incomplete);
    expect(() => validateKbfReferenceV1(incomplete)).toThrow(/requires reasoningStrategy/);

    const unsupported = reference();
    unsupported.generator.params.referenceEndpointRequest = { ...settings, reasoningStrategy: 'loud' };
    unsupported.referenceId = computeReferenceId(unsupported);
    expect(() => validateKbfReferenceV1(unsupported)).toThrow(/unsupported reasoning strategy/);
  });

  it('requires explicit operator trust for imported references', () => {
    const value = reference('imported');
    expect(() => validateKbfReferenceV1(value)).toThrow(/explicit operator trust/);
    expect(validateKbfReferenceV1(value, { trustImported: true })).toEqual(value);
  });

  it('rejects aggregate self-test drift, tampered power evidence, and reference id drift', () => {
    const aggregateDrift = reference();
    aggregateDrift.selfTest.hamming = 1;
    aggregateDrift.referenceId = computeReferenceId(aggregateDrift);
    expect(() => validateKbfReferenceV1(aggregateDrift)).toThrow(/aggregate selfTest/);

    const informationalContrast = reference();
    informationalContrast.contrasts[0]!.distinguishingProbeIds = [];
    informationalContrast.referenceId = computeReferenceId(informationalContrast);
    expect(() => validateKbfReferenceV1(informationalContrast)).not.toThrow();

    const tamperedPower = reference();
    tamperedPower.statisticalPowerEvidence.power -= 0.01;
    tamperedPower.referenceId = computeReferenceId(tamperedPower);
    expect(() => validateKbfReferenceV1(tamperedPower)).toThrow(/statisticalPowerEvidence/);

    const wrongId = reference();
    wrongId.referenceId = '0x' + 'ff'.repeat(32);
    expect(() => validateKbfReferenceV1(wrongId)).toThrow(/referenceId mismatch/);
  });

  it('accepts every ten-probe multiple through 750 and rejects invalid counts', () => {
    for (let count = 10; count <= 750; count += 10) {
      const value = reference();
      value.probes = value.probes.slice(0, count);
      if (count > 100) {
        const template = value.probes[0]!;
        for (let index = 100; index < count; index += 1) {
          value.probes.push({ ...template, id: `extra-${index}`, name: `extra-${index}`, consensus: index });
        }
      }
      value.selfTest.outcomes = value.probes.map((probe) => ({
        probeId: probe.id, answers: [probe.consensus], matches: [1 as const],
      }));
      value.selfTest = { ...value.selfTest, hamming: 0, total: count, coverage: 1, errorRate: 0 };
      value.selectedProbeCount = count;
      const power = computeBinomialPower({
        selfHamming: 0, selfTotal: count, probeCount: count, minimumMismatchDelta: value.minimumMismatchDelta,
      });
      value.statisticalPower = power.power;
      value.statisticalPowerEvidence = {
        test: 'one-sided-binomial', alpha: 0.05, clopperPearsonConfidence: 0.99,
        selfHamming: 0, selfTotal: count, probeCount: count, p0UpperBound: power.p0,
        alternativeMismatchRate: power.p1, criticalMismatchCount: power.criticalMismatchCount, power: power.power,
      };
      value.contrasts = [];
      value.referenceId = computeReferenceId(value);
      if (power.power >= 0.9) expect(() => validateKbfReferenceV1(value)).not.toThrow();
    }
    for (const count of [0, 15, 760]) {
      const value = reference();
      value.selectedProbeCount = count;
      value.referenceId = computeReferenceId(value);
      expect(() => validateKbfReferenceV1(value)).toThrow(/multiple of 10 from 10 through 750/);
    }
  });

  it('validates power using the alpha and confidence persisted in the reference', () => {
    const value = reference();
    const alpha = 0.02;
    const cpConfidence = 0.985;
    const power = computeBinomialPower({
      selfHamming: value.selfTest.hamming,
      selfTotal: value.selfTest.total,
      probeCount: value.probes.length,
      minimumMismatchDelta: value.minimumMismatchDelta,
      alpha,
      cpConfidence,
    });
    value.statisticalPower = power.power;
    value.statisticalPowerEvidence = {
      test: 'one-sided-binomial',
      alpha,
      clopperPearsonConfidence: cpConfidence,
      selfHamming: value.selfTest.hamming,
      selfTotal: value.selfTest.total,
      probeCount: value.probes.length,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    };
    value.referenceId = computeReferenceId(value);
    expect(() => validateKbfReferenceV1(value)).not.toThrow();
  });

  it('supports an explicit lower analytics-only power threshold', () => {
    const value = reference();
    const alpha = 0.005;
    const cpConfidence = 0.99;
    value.probes = Array.from({ length: 150 }, (_unused, index) => ({
      ...value.probes[index % value.probes.length]!,
      id: `analytics-${index}`,
      name: `analytics-${index}`,
      consensus: index,
    }));
    value.selectedProbeCount = value.probes.length;
    value.selfTest.outcomes = value.probes.map((probe, index) => ({
      probeId: probe.id,
      answers: [index < 5 ? probe.consensus + 1 : probe.consensus],
      matches: [index < 5 ? 0 as const : 1 as const],
    }));
    value.selfTest = {
      ...value.selfTest,
      hamming: 5,
      total: 150,
      coverage: 1,
      errorRate: 5 / 150,
    };
    const power = computeBinomialPower({
      selfHamming: 5,
      selfTotal: 150,
      probeCount: 150,
      minimumMismatchDelta: value.minimumMismatchDelta,
      alpha,
      cpConfidence,
    });
    value.statisticalPower = power.power;
    value.statisticalPowerEvidence = {
      test: 'one-sided-binomial',
      alpha,
      clopperPearsonConfidence: cpConfidence,
      selfHamming: 5,
      selfTotal: 150,
      probeCount: 150,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    };
    value.contrasts = [];
    value.referenceId = computeReferenceId(value);

    expect(power.power).toBeGreaterThanOrEqual(0.85);
    expect(power.power).toBeLessThan(0.9);
    expect(() => validateKbfReferenceV1(value)).toThrow(/statisticalPower/);
    expect(() => validateKbfReferenceV1(value, { minimumStatisticalPower: 0.85 })).not.toThrow();
  });

  it('rejects self-test runs whose match disagrees with the recorded answer', () => {
    const forged = reference();
    forged.selfTest.outcomes[0] = { probeId: 'p-0', answers: [999, 0, 0], matches: [1, 1, 1] };
    forged.referenceId = computeReferenceId(forged);
    expect(() => validateKbfReferenceV1(forged)).toThrow(/inconsistent with its answer/);

    const ragged = reference();
    ragged.selfTest.outcomes[0] = { probeId: 'p-0', answers: [0, 0], matches: [1, 1, 1] };
    ragged.referenceId = computeReferenceId(ragged);
    expect(() => validateKbfReferenceV1(ragged)).toThrow(/one answer and match per run/);
  });

  it('computes power for the audit probe count from pooled self-test trials', () => {
    const pooled = computeBinomialPower({
      selfHamming: 6, selfTotal: 300, probeCount: 100, minimumMismatchDelta: 0.1,
    });
    const single = computeBinomialPower({
      selfHamming: 2, selfTotal: 100, probeCount: 100, minimumMismatchDelta: 0.1,
    });
    expect(pooled.probeCount).toBe(100);
    expect(pooled.p0).toBeLessThan(single.p0);
    expect(pooled.criticalMismatchCount).not.toBeNull();
    expect(pooled.criticalMismatchCount!).toBeLessThanOrEqual(100);

    const value = reference();
    value.statisticalPowerEvidence.probeCount = value.probes.length * RUNS;
    value.referenceId = computeReferenceId(value);
    expect(() => validateKbfReferenceV1(value)).toThrow(/statisticalPowerEvidence/);
  });

  it('rejects missing or duplicate per-probe self-test outcomes', () => {
    const missing = reference();
    missing.selfTest.outcomes.pop();
    missing.referenceId = computeReferenceId(missing);
    expect(() => validateKbfReferenceV1(missing)).toThrow(/one entry per probe/);

    const duplicate = reference();
    duplicate.selfTest.outcomes[1] = { ...duplicate.selfTest.outcomes[0]! };
    duplicate.referenceId = computeReferenceId(duplicate);
    expect(() => validateKbfReferenceV1(duplicate)).toThrow(/duplicate self-test outcome/);
  });
});
