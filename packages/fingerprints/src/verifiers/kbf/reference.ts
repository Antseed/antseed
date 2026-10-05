import { canonicalHash, sha256Hex } from '../../canonical-json.js';
import {
  computeReferenceId,
  type FingerprintReference,
  type KbfProbe,
  type MatchEntry,
} from '../../types.js';
import { KBF_SYSTEM_PROMPT } from './prompts.js';
import { binomialOneSidedPValue, clopperPearsonUpper } from './stats.js';

export const KBF_REFERENCE_VERSION = 1;
export const KBF_PARSER_VERSION = 'kbf-numeric-lines-v1';
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

export interface ReferenceQueryProfileV1 {
  version: 1;
  apiProtocol: 'openai-chat-completions';
  upstreamModel: string;
  enrollmentTemperatures: [0, 0.7, 0.7];
  selfTestTemperature: 0;
  contrastTemperature: 0;
  auditTemperature: 0;
  systemPromptHash: string;
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

export interface ReferenceProbeSelfTestV1 {
  probeId: string;
  answer: number | null;
  match: MatchEntry;
}

export interface ReferenceContrastV1 {
  model: string;
  distinguishingProbeIds: string[];
}

export interface KbfReferenceSelfTestV1 {
  hamming: number;
  total: number;
  coverage: number;
  errorRate: number;
  outcomes: ReferenceProbeSelfTestV1[];
  [extension: string]: unknown;
}

export interface KbfReferenceV1 extends FingerprintReference {
  version: 1;
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
    version: 1,
    apiProtocol: 'openai-chat-completions',
    upstreamModel,
    enrollmentTemperatures: [...KBF_ENROLLMENT_TEMPERATURES],
    selfTestTemperature: KBF_EXECUTION_TEMPERATURE,
    contrastTemperature: KBF_EXECUTION_TEMPERATURE,
    auditTemperature: KBF_EXECUTION_TEMPERATURE,
    systemPromptHash: `sha256:${sha256Hex(KBF_SYSTEM_PROMPT)}`,
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

export function computeBinomialPower(input: {
  selfHamming: number;
  selfTotal: number;
  minimumMismatchDelta: number;
  alpha?: number;
  cpConfidence?: number;
}): BinomialPowerResult {
  const alpha = input.alpha ?? 0.05;
  const cpConfidence = input.cpConfidence ?? 0.99;
  if (!(input.minimumMismatchDelta > 0 && input.minimumMismatchDelta <= 1)) {
    throw new Error('minimumMismatchDelta must be in (0, 1]');
  }
  const p0 = clopperPearsonUpper(input.selfHamming, input.selfTotal, cpConfidence);
  const p1 = Math.min(1, p0 + input.minimumMismatchDelta);
  let criticalMismatchCount: number | null = null;
  for (let mismatches = 0; mismatches <= input.selfTotal; mismatches += 1) {
    if (binomialOneSidedPValue(mismatches, input.selfTotal, p0) < alpha) {
      criticalMismatchCount = mismatches;
      break;
    }
  }
  return {
    probeCount: input.selfTotal,
    p0,
    p1,
    criticalMismatchCount,
    power: criticalMismatchCount === null
      ? 0
      : binomialOneSidedPValue(criticalMismatchCount, input.selfTotal, p1),
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
  const parsed = selected.filter((outcome) => outcome.match !== null).length;
  const hamming = selected.filter((outcome) => outcome.match !== 1).length;
  return {
    hamming,
    total: selected.length,
    coverage: selected.length === 0 ? 0 : parsed / selected.length,
    errorRate: selected.length === 0 ? 0 : hamming / selected.length,
    outcomes: selected,
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
    throw new Error('reference must be KBF schema version 1');
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
  for (const outcome of selfTest.outcomes) {
    object(outcome, 'selfTest outcome');
    nonEmpty(outcome.probeId, 'selfTest outcome probeId');
    if (!probeIds.has(outcome.probeId) || outcomeIds.has(outcome.probeId)) {
      throw new Error(`invalid or duplicate self-test outcome ${outcome.probeId}`);
    }
    outcomeIds.add(outcome.probeId);
    if (outcome.answer !== null && !Number.isFinite(outcome.answer)) throw new Error('invalid self-test answer');
    if (outcome.match !== null && outcome.match !== 0 && outcome.match !== 1) throw new Error('invalid self-test match');
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
  if (profile.version !== 1 || profile.apiProtocol !== 'openai-chat-completions') throw new Error('invalid query profile');
  nonEmpty(profile.upstreamModel, 'queryProfile.upstreamModel');
  if (JSON.stringify(profile.enrollmentTemperatures) !== JSON.stringify(KBF_ENROLLMENT_TEMPERATURES)) {
    throw new Error('enrollment temperatures must be [0, 0.7, 0.7]');
  }
  if (profile.selfTestTemperature !== 0 || profile.contrastTemperature !== 0 || profile.auditTemperature !== 0) {
    throw new Error('self-test, contrast, and audit temperatures must be 0');
  }
  if (profile.systemPromptHash !== `sha256:${sha256Hex(KBF_SYSTEM_PROMPT)}`) throw new Error('system prompt hash mismatch');
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
