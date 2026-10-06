import { canonicalHash } from '../../canonical-json.js';
import {
  computeReferenceId,
  type FingerprintReference,
  type KbfProbe,
  type MatchEntry,
} from '../../types.js';
import { kbfPromptVariantsHash } from './prompts.js';
import { matchesTolerance } from './scoring.js';
import { binomialOneSidedPValue, clopperPearsonUpper } from './stats.js';

/**
 * Version 2: query profiles pin the prompt variant set (`promptVariantsHash`)
 * instead of a single system prompt. Version 1 references are rejected and
 * must be rebuilt.
 */
export const KBF_REFERENCE_VERSION = 2;
export const KBF_PARSER_VERSION = 'kbf-numeric-lines-v2';
export const KBF_PROBES_PER_REQUEST = 10;
export const KBF_MIN_PROBE_COUNT = 10;
export const KBF_MAX_PROBE_COUNT = 750;
export const KBF_SUPPORTED_PROBE_COUNTS = Object.freeze(
  Array.from(
    { length: KBF_MAX_PROBE_COUNT / KBF_PROBES_PER_REQUEST },
    (_unused, index) => (index + 1) * KBF_PROBES_PER_REQUEST,
  ),
);
export const KBF_ENROLLMENT_TEMPERATURES = [0, 0.7, 0.7] as const;
export const KBF_EXECUTION_TEMPERATURE = 0;
/** Independent self-test runs per probe (shuffled batches, random prompt variant). */
export const KBF_DEFAULT_SELF_TEST_RUNS = 3;

export interface ReferenceQueryProfileV1 {
  version: 2;
  apiProtocol: 'openai-chat-completions';
  upstreamModel: string;
  enrollmentTemperatures: [0, 0.7, 0.7];
  selfTestTemperature: 0;
  contrastTemperature: 0;
  auditTemperature: 0;
  /** Hash over every KBF prompt variant; each request uses one variant from this set. */
  promptVariantsHash: string;
  parserVersion: typeof KBF_PARSER_VERSION;
  probesPerRequest: 10;
  maxTokensPerRequest: number;
  requestTimeoutMs: number;
  generationSettings: {
    topP: 1;
    seed: null;
    responseFormat: 'text';
  };
  /** Endpoint-specific method used to minimize hidden reasoning output. */
  reasoningStrategy?: 'reasoning-effort-none' | 'reasoning-effort-minimum-supported' | 'disable-thinking' | 'bare';
  /** Exact additional request fields applied to reference and target queries. */
  requestOverrides?: Record<string, unknown>;
  /** Standard request fields intentionally omitted for endpoint compatibility. */
  requestOmissions?: Array<'temperature' | 'top_p'>;
}

/**
 * Per-probe self-test outcomes, one entry per run. Each run re-asks the probe
 * under audit conditions (shuffled domain batches of ten, a random prompt
 * variant), so the pooled error rate reflects what an honest seller serving
 * the same model would score.
 */
export interface ReferenceProbeSelfTestV1 {
  probeId: string;
  /** Parsed answer per run; null when the reference gave no parseable answer. */
  answers: Array<number | null>;
  /**
   * Match per run, scored exactly like a target answer: 1 within tolerance,
   * 0 discrepancy (including a missing or refused answer), null only when the
   * run could not be attempted at all.
   */
  matches: MatchEntry[];
}

export interface ReferenceContrastV1 {
  model: string;
  distinguishingProbeIds: string[];
}

/**
 * Pooled self-test: `hamming` and `total` count individual runs (trials)
 * across all probes, not probes. `coverage` is parsed answers per trial.
 */
export interface KbfReferenceSelfTestV1 {
  hamming: number;
  total: number;
  coverage: number;
  errorRate: number;
  outcomes: ReferenceProbeSelfTestV1[];
  [extension: string]: unknown;
}

export interface KbfReferenceV1 extends FingerprintReference {
  version: typeof KBF_REFERENCE_VERSION;
  kind: 'kbf';
  queryProfile: ReferenceQueryProfileV1;
  selfTest: KbfReferenceSelfTestV1;
  selectedProbeCount: number;
  minimumMismatchDelta: number;
  statisticalPower: number;
  statisticalPowerEvidence: StatisticalPowerEvidenceV1;
  contrasts: ReferenceContrastV1[];
}

export interface StatisticalPowerEvidenceV1 {
  test: 'one-sided-binomial';
  alpha: number;
  clopperPearsonConfidence: number;
  selfHamming: number;
  selfTotal: number;
  /** Audit probe count the power is computed for (the reference's probe count). */
  probeCount: number;
  p0UpperBound: number;
  alternativeMismatchRate: number;
  criticalMismatchCount: number | null;
  power: number;
}

export interface BinomialPowerResult {
  probeCount: number;
  p0: number;
  p1: number;
  criticalMismatchCount: number | null;
  power: number;
}

export function createReferenceQueryProfile(input: {
  upstreamModel: string;
  maxTokensPerRequest?: number;
  requestTimeoutMs?: number;
}): ReferenceQueryProfileV1 {
  const upstreamModel = input.upstreamModel.trim();
  if (!upstreamModel) throw new Error('query profile upstreamModel must not be empty');
  return {
    version: 2,
    apiProtocol: 'openai-chat-completions',
    upstreamModel,
    enrollmentTemperatures: [...KBF_ENROLLMENT_TEMPERATURES],
    selfTestTemperature: KBF_EXECUTION_TEMPERATURE,
    contrastTemperature: KBF_EXECUTION_TEMPERATURE,
    auditTemperature: KBF_EXECUTION_TEMPERATURE,
    promptVariantsHash: kbfPromptVariantsHash(),
    parserVersion: KBF_PARSER_VERSION,
    probesPerRequest: KBF_PROBES_PER_REQUEST,
    maxTokensPerRequest: input.maxTokensPerRequest ?? 160,
    requestTimeoutMs: input.requestTimeoutMs ?? 120_000,
    generationSettings: {
      topP: 1,
      seed: null,
      responseFormat: 'text',
    },
  };
}

export function queryProfileHash(profile: ReferenceQueryProfileV1): string {
  return canonicalHash(profile);
}

export function assertMatchingQueryProfile(
  referenceProfile: ReferenceQueryProfileV1,
  executionProfile: ReferenceQueryProfileV1,
): void {
  const referenceHash = queryProfileHash(referenceProfile);
  const executionHash = queryProfileHash(executionProfile);
  if (referenceHash !== executionHash) {
    throw new Error(`KBF query profile mismatch (${executionHash} != ${referenceHash})`);
  }
}

/**
 * Power of the one-sided binomial audit test. p0 comes from the pooled
 * self-test trials (`selfHamming`/`selfTotal`); the audit itself scores
 * `probeCount` target answers, so the critical count and power use that n.
 */
export function computeBinomialPower(input: {
  selfHamming: number;
  selfTotal: number;
  probeCount: number;
  minimumMismatchDelta: number;
  alpha?: number;
  cpConfidence?: number;
}): BinomialPowerResult {
  const alpha = input.alpha ?? 0.05;
  const cpConfidence = input.cpConfidence ?? 0.99;
  if (!(input.minimumMismatchDelta > 0 && input.minimumMismatchDelta <= 1)) {
    throw new Error('minimumMismatchDelta must be in (0, 1]');
  }
  if (!Number.isInteger(input.probeCount) || input.probeCount <= 0) {
    throw new Error('probeCount must be a positive integer');
  }
  const p0 = clopperPearsonUpper(input.selfHamming, input.selfTotal, cpConfidence);
  const p1 = Math.min(1, p0 + input.minimumMismatchDelta);
  let criticalMismatchCount: number | null = null;
  for (let mismatches = 0; mismatches <= input.probeCount; mismatches += 1) {
    if (binomialOneSidedPValue(mismatches, input.probeCount, p0) < alpha) {
      criticalMismatchCount = mismatches;
      break;
    }
  }
  return {
    probeCount: input.probeCount,
    p0,
    p1,
    criticalMismatchCount,
    power: criticalMismatchCount === null
      ? 0
      : binomialOneSidedPValue(criticalMismatchCount, input.probeCount, p1),
  };
}

export function subsetReferenceSelfTest(
  reference: Pick<KbfReferenceV1, 'probes' | 'selfTest'>,
  selectedProbeIds: readonly string[],
): KbfReferenceSelfTestV1 {
  const outcomes = new Map(reference.selfTest.outcomes.map((outcome) => [outcome.probeId, outcome]));
  const selected = selectedProbeIds.map((probeId) => {
    const outcome = outcomes.get(probeId);
    if (!outcome) throw new Error(`reference self-test missing selected probe ${probeId}`);
    return outcome;
  });
  return aggregateKbfSelfTestOutcomes(selected);
}

/**
 * Pool per-probe self-test runs into the honest-error baseline.
 *
 * Null handling mirrors target scoring so p0 and the target statistic count
 * the same thing: a missing, unparseable, or refused answer is a discrepancy
 * (0) on both sides, while a null match (the trial could not be attempted)
 * is excluded from both hamming and total. Reference builders never emit
 * null matches (a transport failure aborts the build), so in practice every
 * refusal counts against the reference, which keeps p0 conservative: a
 * genuine seller that refuses the same probes is not penalised for it.
 */
export function aggregateKbfSelfTestOutcomes(
  outcomes: ReferenceProbeSelfTestV1[],
): KbfReferenceSelfTestV1 {
  let trials = 0;
  let parsed = 0;
  let total = 0;
  let hamming = 0;
  for (const outcome of outcomes) {
    for (const [run, match] of outcome.matches.entries()) {
      trials += 1;
      if (outcome.answers[run] !== null && outcome.answers[run] !== undefined) parsed += 1;
      if (match === null) continue;
      total += 1;
      if (match === 0) hamming += 1;
    }
  }
  return {
    hamming,
    total,
    coverage: trials === 0 ? 0 : parsed / trials,
    errorRate: total === 0 ? 0 : hamming / total,
    outcomes,
  };
}

export function validateKbfReferenceV1(
  value: unknown,
  options: { trustImported?: boolean; minimumStatisticalPower?: number } = {},
): KbfReferenceV1 {
  const minimumStatisticalPower = options.minimumStatisticalPower ?? 0.9;
  if (!(minimumStatisticalPower > 0 && minimumStatisticalPower <= 1)) {
    throw new Error('minimumStatisticalPower must be in (0, 1]');
  }
  const reference = object(value, 'reference') as unknown as KbfReferenceV1;
  if (reference.version !== KBF_REFERENCE_VERSION || reference.kind !== 'kbf') {
    throw new Error(`reference must be KBF schema version ${KBF_REFERENCE_VERSION}; rebuild older references`);
  }
  nonEmpty(reference.referenceId, 'referenceId');
  nonEmpty(reference.referenceModel, 'referenceModel');
  nonEmpty(reference.createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(reference.createdAt))) throw new Error('createdAt must be an ISO timestamp');
  if (!['public', 'generated', 'imported'].includes(reference.source)) throw new Error('invalid reference source');
  if (reference.source === 'imported' && options.trustImported !== true) {
    throw new Error('imported reference requires explicit operator trust');
  }
  stringArray(reference.serviceAliases, 'serviceAliases', 1);
  validateQueryProfile(reference.queryProfile);
  if (
    !Number.isInteger(reference.selectedProbeCount)
    || reference.selectedProbeCount < KBF_MIN_PROBE_COUNT
    || reference.selectedProbeCount > KBF_MAX_PROBE_COUNT
    || reference.selectedProbeCount % KBF_PROBES_PER_REQUEST !== 0
  ) {
    throw new Error(`selectedProbeCount must be a multiple of 10 from 10 through ${KBF_MAX_PROBE_COUNT}`);
  }
  if (!Array.isArray(reference.probes) || reference.probes.length !== reference.selectedProbeCount) {
    throw new Error('probes length must equal selectedProbeCount');
  }
  const probeIds = new Set<string>();
  for (const probe of reference.probes) validateProbe(probe, probeIds);
  if (!(reference.minimumMismatchDelta > 0 && reference.minimumMismatchDelta <= 1)) {
    throw new Error('minimumMismatchDelta must be in (0, 1]');
  }
  if (!(reference.statisticalPower >= minimumStatisticalPower && reference.statisticalPower <= 1)) {
    throw new Error(`statisticalPower must be in [${minimumStatisticalPower}, 1]`);
  }
  const selfTest = object(reference.selfTest, 'selfTest') as unknown as KbfReferenceSelfTestV1;
  if (!Array.isArray(selfTest.outcomes) || selfTest.outcomes.length !== reference.probes.length) {
    throw new Error('selfTest outcomes must contain exactly one entry per probe');
  }
  const outcomeIds = new Set<string>();
  const probesById = new Map(reference.probes.map((probe) => [probe.id, probe]));
  for (const outcome of selfTest.outcomes) {
    object(outcome, 'selfTest outcome');
    nonEmpty(outcome.probeId, 'selfTest outcome probeId');
    if (!probeIds.has(outcome.probeId) || outcomeIds.has(outcome.probeId)) {
      throw new Error(`invalid or duplicate self-test outcome ${outcome.probeId}`);
    }
    outcomeIds.add(outcome.probeId);
    if (!Array.isArray(outcome.answers) || !Array.isArray(outcome.matches)
      || outcome.matches.length === 0 || outcome.answers.length !== outcome.matches.length) {
      throw new Error(`self-test outcome ${outcome.probeId} must have one answer and match per run`);
    }
    const probe = probesById.get(outcome.probeId)!;
    for (const [run, match] of outcome.matches.entries()) {
      const answer = outcome.answers[run];
      if (answer !== null && (typeof answer !== 'number' || !Number.isFinite(answer))) {
        throw new Error('invalid self-test answer');
      }
      if (match !== null && match !== 0 && match !== 1) throw new Error('invalid self-test match');
      if (match !== null && match !== (answer !== null && matchesTolerance(answer, probe) ? 1 : 0)) {
        throw new Error(`self-test match for ${outcome.probeId} run ${run} is inconsistent with its answer`);
      }
    }
  }
  const recomputedSelfTest = subsetReferenceSelfTest(reference, reference.probes.map((probe) => probe.id));
  if (
    selfTest.hamming !== recomputedSelfTest.hamming
    || selfTest.total !== recomputedSelfTest.total
    || selfTest.coverage !== recomputedSelfTest.coverage
    || selfTest.errorRate !== recomputedSelfTest.errorRate
  ) {
    throw new Error('aggregate selfTest is inconsistent with per-probe outcomes');
  }
  if (!Array.isArray(reference.contrasts)) throw new Error('contrasts must be an array');
  for (const contrast of reference.contrasts) {
    object(contrast, 'contrast');
    nonEmpty(contrast.model, 'contrast model');
    const distinguishing = stringArray(contrast.distinguishingProbeIds, 'distinguishingProbeIds', 0);
    if (new Set(distinguishing).size !== distinguishing.length) throw new Error('duplicate contrast probe id');
    if (distinguishing.some((probeId) => !probeIds.has(probeId))) throw new Error('contrast references unknown probe');
  }
  const evidence = object(reference.statisticalPowerEvidence, 'statisticalPowerEvidence') as unknown as StatisticalPowerEvidenceV1;
  if (!(evidence.alpha > 0 && evidence.alpha < 1)) {
    throw new Error('statisticalPowerEvidence.alpha must be in (0, 1)');
  }
  if (!(evidence.clopperPearsonConfidence > 0 && evidence.clopperPearsonConfidence < 1)) {
    throw new Error('statisticalPowerEvidence.clopperPearsonConfidence must be in (0, 1)');
  }
  const powerInput = {
    selfHamming: selfTest.hamming,
    selfTotal: selfTest.total,
    probeCount: reference.probes.length,
    minimumMismatchDelta: reference.minimumMismatchDelta,
    alpha: evidence.alpha,
    cpConfidence: evidence.clopperPearsonConfidence,
  };
  const recomputedPower = computeBinomialPower(powerInput);
  const expectedEvidence: StatisticalPowerEvidenceV1 = {
    test: 'one-sided-binomial',
    alpha: evidence.alpha,
    clopperPearsonConfidence: evidence.clopperPearsonConfidence,
    selfHamming: selfTest.hamming,
    selfTotal: selfTest.total,
    probeCount: reference.probes.length,
    p0UpperBound: recomputedPower.p0,
    alternativeMismatchRate: recomputedPower.p1,
    criticalMismatchCount: recomputedPower.criticalMismatchCount,
    power: recomputedPower.power,
  };
  const evidenceMatches = Object.entries(expectedEvidence).every(([key, expected]) => {
    const actual = evidence[key as keyof StatisticalPowerEvidenceV1];
    return typeof expected === 'number' && typeof actual === 'number'
      ? Math.abs(actual - expected) <= 1e-12
      : actual === expected;
  });
  if (!evidenceMatches) throw new Error('statisticalPowerEvidence is inconsistent with the selected self-test baseline');
  if (Math.abs(recomputedPower.power - reference.statisticalPower) > 1e-12
    || recomputedPower.power < minimumStatisticalPower) {
    throw new Error('statisticalPower is inconsistent with the selected self-test baseline');
  }
  const expectedReferenceId = computeReferenceId(reference);
  if (reference.referenceId !== expectedReferenceId) {
    throw new Error(`referenceId mismatch (${reference.referenceId} != ${expectedReferenceId})`);
  }
  return reference;
}

function validateQueryProfile(profile: ReferenceQueryProfileV1): void {
  object(profile, 'queryProfile');
  if (profile.version !== 2 || profile.apiProtocol !== 'openai-chat-completions') throw new Error('invalid query profile');
  nonEmpty(profile.upstreamModel, 'queryProfile.upstreamModel');
  if (JSON.stringify(profile.enrollmentTemperatures) !== JSON.stringify(KBF_ENROLLMENT_TEMPERATURES)) {
    throw new Error('enrollment temperatures must be [0, 0.7, 0.7]');
  }
  if (profile.selfTestTemperature !== 0 || profile.contrastTemperature !== 0 || profile.auditTemperature !== 0) {
    throw new Error('self-test, contrast, and audit temperatures must be 0');
  }
  if (profile.promptVariantsHash !== kbfPromptVariantsHash()) throw new Error('prompt variants hash mismatch');
  if (profile.parserVersion !== KBF_PARSER_VERSION) throw new Error('parser version mismatch');
  if (profile.probesPerRequest !== 10) throw new Error('query profile must use ten probes per request');
  positiveInteger(profile.maxTokensPerRequest, 'maxTokensPerRequest');
  positiveInteger(profile.requestTimeoutMs, 'requestTimeoutMs');
  const settings = object(profile.generationSettings, 'generationSettings');
  if (settings.topP !== 1 || settings.seed !== null || settings.responseFormat !== 'text') {
    throw new Error('unsupported generation settings');
  }
  if (profile.reasoningStrategy !== undefined
    && !['reasoning-effort-none', 'reasoning-effort-minimum-supported', 'disable-thinking', 'bare']
      .includes(profile.reasoningStrategy)) {
    throw new Error('unsupported reasoning strategy');
  }
  if (profile.requestOverrides !== undefined) object(profile.requestOverrides, 'requestOverrides');
  if (profile.requestOmissions !== undefined) {
    if (!Array.isArray(profile.requestOmissions)
      || profile.requestOmissions.some((field) => !['temperature', 'top_p'].includes(field))
      || new Set(profile.requestOmissions).size !== profile.requestOmissions.length) {
      throw new Error('unsupported request omissions');
    }
  }
}

function validateProbe(probe: KbfProbe, ids: Set<string>): void {
  object(probe, 'probe');
  nonEmpty(probe.id, 'probe.id');
  if (ids.has(probe.id)) throw new Error(`duplicate probe id ${probe.id}`);
  ids.add(probe.id);
  nonEmpty(probe.name, 'probe.name');
  nonEmpty(probe.domain, 'probe.domain');
  nonEmpty(probe.template, 'probe.template');
  if (!probe.template.includes('___')) throw new Error(`probe ${probe.id} template must contain ___`);
  if (!Number.isFinite(probe.consensus)) throw new Error(`probe ${probe.id} consensus must be finite`);
  if (!Array.isArray(probe.range) || probe.range.length !== 2 || !probe.range.every(Number.isFinite)) {
    throw new Error(`probe ${probe.id} range is invalid`);
  }
  if (probe.range[0] > probe.range[1] || probe.consensus < probe.range[0] || probe.consensus > probe.range[1]) {
    throw new Error(`probe ${probe.id} consensus is outside range`);
  }
  if (!probe.tolerance || !['absolute', 'relative'].includes(probe.tolerance.mode)
    || !Number.isFinite(probe.tolerance.value) || probe.tolerance.value < 0) {
    throw new Error(`probe ${probe.id} tolerance is invalid`);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
}

function stringArray(value: unknown, name: string, minimumLength: number): string[] {
  if (!Array.isArray(value) || value.length < minimumLength || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`${name} must contain at least ${minimumLength} non-empty strings`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): void {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${name} must be a positive integer`);
}
