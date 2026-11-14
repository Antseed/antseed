import { canonicalHash } from '../../canonical-json.js';
import {
  computeReferenceId,
  type FingerprintReference,
  type KbfProbe,
  type MatchEntry,
} from '../../types.js';
import { getKbfPromptVariant, kbfPromptVariantsHash } from './prompts.js';
import { matchesTolerance, scoreKbfAnswer } from './scoring.js';
import { binomialOneSidedPValue, clopperPearsonUpper } from './stats.js';

/**
 * Version 2: query profiles pin the prompt variant set (`promptVariantsHash`)
 * instead of a single system prompt. Version 1 references are rejected and
 * must be rebuilt.
 */
export const KBF_REFERENCE_VERSION = 2;
export const KBF_PARSER_VERSION = 'kbf-numeric-lines-v3';
/**
 * Parser versions a stored reference may name. v3 reads every labelled reply as v2 did, except a
 * Unicode minus and a bare decimal at the start of a line, and neither is in a stored self-test, so
 * references enrolled under v2 stay valid to read (published ones keep validating for `antseed-verify`).
 */
export const KBF_READABLE_PARSER_VERSIONS = [KBF_PARSER_VERSION, 'kbf-numeric-lines-v2'] as const;
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
/** Separate self-test runs per probe (shuffled batches, a prompt variant per batch), pooled as trials. The KBF reference code runs one. */
export const KBF_DEFAULT_SELF_TEST_RUNS = 3;
/** Calibration passes over a question set's own batches. One pass gives the KBF reference code's margin. */
export const KBF_CALIBRATION_PASSES = 1;
export const KBF_CALIBRATION_METHOD = 'kbf-set-calibration-v1';

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
  parserVersion: (typeof KBF_READABLE_PARSER_VERSIONS)[number];
  probesPerRequest: 10;
  maxTokensPerRequest: number;
  requestTimeoutMs: number;
  generationSettings: {
    topP: 1;
    seed: null;
    responseFormat: 'text';
  };
  /**
   * Legacy location of reference-endpoint request settings. New references
   * record them in `generator.params.referenceEndpointRequest` instead. They
   * describe how the reference endpoint was queried. Only their thinking
   * suppression can reach a target, as a fallback when the target's own
   * discovery finds none (`kbfTargetThinkingSuppression`).
   */
  reasoningStrategy?: ReferenceReasoningStrategy;
  /** Legacy: see `reasoningStrategy`. */
  requestOverrides?: Record<string, unknown>;
  /** Legacy: see `reasoningStrategy`. */
  requestOmissions?: Array<'temperature' | 'top_p'>;
}

/**
 * How hidden reasoning ("thinking") was suppressed. New references discover it
 * like the KBF reference code: each strategy is tried in order on a fixed test
 * batch and the first one that yields at least 5/10 parseable answers with zero
 * reasoning tokens is kept (`bare` may think). `bare-expanded` means nothing
 * suppressed thinking, so requests get a much larger token budget instead.
 * `reasoning-effort-minimum-supported` is only found in older references.
 */
export type ReferenceReasoningStrategy =
  | 'reasoning-effort-none'
  | 'reasoning-effort-minimal'
  | 'reasoning-effort-minimum-supported'
  | 'disable-thinking'
  | 'enable-thinking-false'
  | 'prefill'
  | 'bare'
  | 'bare-expanded';

export const KBF_REFERENCE_REASONING_STRATEGIES: readonly ReferenceReasoningStrategy[] = Object.freeze([
  'reasoning-effort-none',
  'reasoning-effort-minimal',
  'reasoning-effort-minimum-supported',
  'disable-thinking',
  'enable-thinking-false',
  'prefill',
  'bare',
  'bare-expanded',
]);

/** Assistant prefill used by the `prefill` strategy (OpenAI Chat Completions only). */
export const KBF_THINKING_PREFILL = '<think></think>';

/** Request fields that carry thinking suppression; audits send these to targets too. */
export const KBF_THINKING_SUPPRESSION_FIELDS = ['reasoning', 'reasoning_effort', 'thinking', 'enable_thinking'] as const;

/**
 * Endpoint-specific settings used only for requests to the reference endpoint
 * (for example, minimizing hidden reasoning or omitting sampling fields an
 * endpoint rejects). Recorded in `generator.params.referenceEndpointRequest`
 * so the reference is reproducible, but outside the query profile, which
 * describes the measurement protocol that target audits follow.
 */
export interface ReferenceEndpointRequestV1 {
  /** Endpoint-specific method used to minimize hidden reasoning output. */
  reasoningStrategy: ReferenceReasoningStrategy;
  /** Exact additional request fields sent to the reference endpoint. */
  requestOverrides: Record<string, unknown>;
  /** Standard request fields omitted for reference-endpoint compatibility. */
  requestOmissions: Array<'temperature' | 'top_p'>;
  /** Assistant message appended to suppress thinking (`prefill` strategy only). */
  assistantPrefill?: typeof KBF_THINKING_PREFILL;
}

/**
 * Fallback thinking suppression for a target whose own discovery found none: the
 * suppression fields of the reference request plus any assistant prefill. (The KBF
 * reference code discovers a strategy per endpoint and has no such fallback.)
 * Endpoint quirks (omitted sampling fields, provider pins) are not included. Null
 * when the reference used none.
 */
export interface KbfThinkingSuppression {
  strategy: ReferenceReasoningStrategy | null;
  overrides: Record<string, unknown>;
  assistantPrefill?: typeof KBF_THINKING_PREFILL;
}

export function kbfTargetThinkingSuppression(
  reference: Pick<KbfReferenceV1, 'queryProfile' | 'generator'>,
): KbfThinkingSuppression | null {
  const request = referenceEndpointRequest(reference);
  if (!request) return null;
  const overrides: Record<string, unknown> = {};
  for (const field of KBF_THINKING_SUPPRESSION_FIELDS) {
    if (request.requestOverrides?.[field] !== undefined) overrides[field] = request.requestOverrides[field];
  }
  if (Object.keys(overrides).length === 0 && !request.assistantPrefill) return null;
  return {
    strategy: request.reasoningStrategy ?? null,
    overrides,
    ...(request.assistantPrefill ? { assistantPrefill: request.assistantPrefill } : {}),
  };
}


/**
 * Per-probe self-test outcomes, one entry per run. Each run re-asks the probe at
 * temperature 0 with a prompt variant, in a shuffled single-domain batch of the
 * probes self-tested together. The CLI builder self-tests each size step's new
 * probes on their own, so many of these batches hold one or two probes, not the
 * up to ten an audit asks together.
 */
export interface ReferenceProbeSelfTestV1 {
  probeId: string;
  /** Parsed answer per run; null when the reference gave no parseable answer. */
  answers: Array<number | null>;
  /**
   * Match per run, scored exactly like a target answer: 1 within tolerance,
   * 0 discrepancy, null unscored (missing, unreadable, or out-of-range answer,
   * or a run that could not be attempted). References built before unscored
   * answers were left out store 0 for a missing answer; validation accepts
   * both forms, and `rescoreKbfSelfTestOutcome` converts the old one.
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

/** One batch of a calibration pass, as sellers get it. */
export interface KbfCalibrationBatchV1 {
  pass: number;
  batchIndex: number;
  probeIds: string[];
  promptVariantId: string;
  /** Requests the batch took, re-asks included. */
  attempts: number;
  /** The kept reply stopped at the token limit, so its answers are not scored. */
  truncated?: true;
}

/**
 * The reference re-asked a question set in the batches sellers get, after the set was chosen and
 * before any seller was asked, as the KBF reference code self-tests the batches it audits. When a
 * reference has one, these trials are the audit's baseline (`kbfAuditBaseline`). `selfTest` stays
 * the enrollment measurement, used for sizing and as a sanity check on the calibration.
 */
export interface KbfReferenceCalibrationV1 extends KbfReferenceSelfTestV1 {
  version: 1;
  method: typeof KBF_CALIBRATION_METHOD;
  passes: number;
  /** Every batch asked, so a third party can match them to the published raw exchanges. */
  batches: KbfCalibrationBatchV1[];
  calibratedAt: string;
}

export interface KbfReferenceV1 extends FingerprintReference {
  version: typeof KBF_REFERENCE_VERSION;
  kind: 'kbf';
  queryProfile: ReferenceQueryProfileV1;
  selfTest: KbfReferenceSelfTestV1;
  calibration?: KbfReferenceCalibrationV1;
  selectedProbeCount: number;
  minimumMismatchDelta: number;
  statisticalPower: number;
  statisticalPowerEvidence: StatisticalPowerEvidenceV1;
  contrasts: ReferenceContrastV1[];
  /**
   * Whether each contrast model would be flagged DIFF by the audit's one-sided
   * binomial test on this probe set, one entry per contrast in the same order.
   * Validates the assumed `minimumMismatchDelta` power against real
   * substitutes. Absent on references built before this check existed.
   */
  contrastDetection?: ReferenceContrastDetectionV1[];
}

export interface ReferenceContrastDetectionV1 {
  model: string;
  /** Selected probes on which the contrast model's answer missed the consensus. */
  mismatches: number;
  /**
   * Selected probes the contrast answered, mirroring the audit's parsed-answer
   * denominator. When per-probe answers are unknown (for example, references
   * drawn from a probe bank) this is the selected probe count, which treats
   * unanswered probes as matches and can only understate detectability.
   */
  total: number;
  /** One-sided binomial p-value of `mismatches` against the self-test bound p0. */
  pValue: number;
  /** pValue < statisticalPowerEvidence.alpha: an audit would return DIFF. */
  detected: boolean;
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

/**
 * Reference-endpoint request settings, read from
 * `generator.params.referenceEndpointRequest` or, for legacy references, from
 * the query profile. Returns null when neither records them.
 */
export function referenceEndpointRequest(
  reference: Pick<KbfReferenceV1, 'queryProfile' | 'generator'>,
): ReferenceEndpointRequestV1 | null {
  const recorded = reference.generator?.params?.referenceEndpointRequest;
  if (recorded !== undefined && recorded !== null) return recorded as ReferenceEndpointRequestV1;
  const profile = reference.queryProfile;
  if (profile.reasoningStrategy === undefined
    && profile.requestOverrides === undefined
    && profile.requestOmissions === undefined) {
    return null;
  }
  return {
    ...(profile.reasoningStrategy !== undefined ? { reasoningStrategy: profile.reasoningStrategy } : {}),
    ...(profile.requestOverrides !== undefined ? { requestOverrides: profile.requestOverrides } : {}),
    ...(profile.requestOmissions !== undefined ? { requestOmissions: profile.requestOmissions } : {}),
  } as ReferenceEndpointRequestV1;
}

/**
 * Hash used to decide whether two references were enrolled compatibly: the
 * query profile with reference-endpoint settings folded back in. This equals
 * the legacy `queryProfileHash` of references that stored those settings in
 * the profile, so banks built before the split stay compatible.
 */
export function referenceCompatibilityProfileHash(
  reference: Pick<KbfReferenceV1, 'queryProfile' | 'generator'>,
): string {
  const endpointRequest = reference.generator?.params?.referenceEndpointRequest as
    | ReferenceEndpointRequestV1
    | undefined;
  if (!endpointRequest) return queryProfileHash(reference.queryProfile);
  return canonicalHash({ ...reference.queryProfile, ...endpointRequest });
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

/**
 * Runs the audit's DIFF test on each contrast model's enrolled outcomes: a
 * contrast mismatches on its distinguishing probes and matches on the other
 * probes it answered. Without `answeredProbeIds` for a model, every selected
 * probe counts as answered.
 */
export function computeContrastDetection(input: {
  probeIds: readonly string[];
  contrasts: readonly ReferenceContrastV1[];
  answeredProbeIds?: ReadonlyMap<string, ReadonlySet<string>>;
  selfHamming: number;
  selfTotal: number;
  alpha: number;
  cpConfidence: number;
}): ReferenceContrastDetectionV1[] {
  const selected = new Set(input.probeIds);
  const p0 = clopperPearsonUpper(input.selfHamming, input.selfTotal, input.cpConfidence);
  return input.contrasts.map((contrast) => {
    const mismatches = new Set(contrast.distinguishingProbeIds.filter((probeId) => selected.has(probeId))).size;
    const answered = input.answeredProbeIds?.get(contrast.model);
    const total = answered
      ? Math.max(mismatches, [...selected].filter((probeId) => answered.has(probeId)).length)
      : selected.size;
    const pValue = contrastDetectionPValue(mismatches, total, p0);
    return { model: contrast.model, mismatches, total, pValue, detected: pValue < input.alpha };
  });
}

function contrastDetectionPValue(mismatches: number, total: number, p0: number): number {
  return total === 0 ? 1 : binomialOneSidedPValue(mismatches, total, p0);
}

export function subsetReferenceSelfTest(
  reference: Pick<KbfReferenceV1, 'probes' | 'selfTest'>,
  selectedProbeIds: readonly string[],
): KbfReferenceSelfTestV1 {
  return selectedOutcomes(reference.selfTest.outcomes, selectedProbeIds);
}

/**
 * What an audit of these probes is judged against: the reference's calibration on the set's own
 * batches when it has one, else its enrollment self-test.
 */
export function kbfAuditBaseline(
  reference: Pick<KbfReferenceV1, 'probes' | 'selfTest' | 'calibration'>,
  selectedProbeIds: readonly string[],
): KbfReferenceSelfTestV1 {
  return selectedOutcomes((reference.calibration ?? reference.selfTest).outcomes, selectedProbeIds);
}

function selectedOutcomes(
  outcomes: readonly ReferenceProbeSelfTestV1[],
  selectedProbeIds: readonly string[],
): KbfReferenceSelfTestV1 {
  const byId = new Map(outcomes.map((outcome) => [outcome.probeId, outcome]));
  return aggregateKbfSelfTestOutcomes(selectedProbeIds.map((probeId) => {
    const outcome = byId.get(probeId);
    if (!outcome) throw new Error(`reference self-test missing selected probe ${probeId}`);
    return outcome;
  }));
}

/**
 * Pool per-probe self-test runs into the honest-error baseline.
 *
 * Null handling mirrors target scoring so p0 and the target statistic count
 * the same thing: a null match (missing, unreadable, or out-of-range answer,
 * or a run that could not be attempted) is excluded from both hamming and
 * total, as in the KBF paper (v3) and its reference code.
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

/**
 * Re-scores one probe's self-test runs with the current rule: a run whose
 * answer is missing, unreadable, or out of range becomes null (unscored)
 * instead of the 0 that older references stored. Runs that were never
 * attempted (null match) stay null.
 */
export function rescoreKbfSelfTestOutcome(
  outcome: ReferenceProbeSelfTestV1,
  probe: KbfProbe,
): ReferenceProbeSelfTestV1 {
  return {
    ...outcome,
    matches: outcome.matches.map((match, run) => (match === null ? null : scoreKbfAnswer(outcome.answers[run], probe))),
  };
}

/**
 * Re-scores a whole reference with the current rule and recomputes everything
 * derived from its self-test: aggregates, statistical power, contrast
 * detection, and the reference ID. Leaving unscored runs out can only lower
 * the self-error bound, so power and contrast detection never get worse.
 * Returns the reference unchanged when it already uses the current rule.
 */
export function rescoreKbfReference(reference: KbfReferenceV1): KbfReferenceV1 {
  const probesById = new Map(reference.probes.map((probe) => [probe.id, probe]));
  const outcomes = reference.selfTest.outcomes.map((outcome) => {
    const probe = probesById.get(outcome.probeId);
    if (!probe) throw new Error(`self-test outcome ${outcome.probeId} has no probe`);
    return rescoreKbfSelfTestOutcome(outcome, probe);
  });
  const changed = outcomes.some((outcome, index) => outcome.matches.some(
    (match, run) => match !== reference.selfTest.outcomes[index]!.matches[run],
  ));
  if (!changed) return reference;
  const { outcomes: _previous, ...selfTestExtensions } = reference.selfTest;
  const selfTest = { ...selfTestExtensions, ...aggregateKbfSelfTestOutcomes(outcomes) };
  const evidence = reference.statisticalPowerEvidence;
  const power = computeBinomialPower({
    selfHamming: selfTest.hamming,
    selfTotal: selfTest.total,
    probeCount: reference.probes.length,
    minimumMismatchDelta: reference.minimumMismatchDelta,
    alpha: evidence.alpha,
    cpConfidence: evidence.clopperPearsonConfidence,
  });
  const p0 = clopperPearsonUpper(selfTest.hamming, selfTest.total, evidence.clopperPearsonConfidence);
  const rescored: KbfReferenceV1 = {
    ...reference,
    referenceId: '',
    selfTest,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      ...evidence,
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      probeCount: reference.probes.length,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    ...(reference.contrastDetection ? {
      contrastDetection: reference.contrastDetection.map((entry) => {
        const pValue = contrastDetectionPValue(entry.mismatches, entry.total, p0);
        return { ...entry, pValue, detected: pValue < evidence.alpha };
      }),
    } : {}),
  };
  rescored.referenceId = computeReferenceId(rescored);
  return rescored;
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
  validateReferenceEndpointRequest(reference);
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
      // Current rule: unscoreable answers are null. References built before it
      // scored a missing answer as 0; both are internally consistent.
      const legacyMatch = answer !== null && matchesTolerance(answer, probe) ? 1 : 0;
      if (match !== null && match !== legacyMatch && match !== scoreKbfAnswer(answer, probe)) {
        throw new Error(`self-test match for ${outcome.probeId} run ${run} is inconsistent with its answer`);
      }
    }
  }
  if (reference.calibration !== undefined) validateCalibration(reference);
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
  if (reference.contrastDetection !== undefined) {
    if (!Array.isArray(reference.contrastDetection)) throw new Error('contrastDetection must be an array');
    // Answered counts are not stored per probe, so `total` is checked for
    // range and the p-value and verdict are recomputed from it.
    const expected = computeContrastDetection({
      probeIds: reference.probes.map((probe) => probe.id),
      contrasts: reference.contrasts,
      selfHamming: selfTest.hamming,
      selfTotal: selfTest.total,
      alpha: evidence.alpha,
      cpConfidence: evidence.clopperPearsonConfidence,
    });
    const p0 = clopperPearsonUpper(selfTest.hamming, selfTest.total, evidence.clopperPearsonConfidence);
    const consistent = reference.contrastDetection.length === expected.length
      && expected.every((entry, index) => {
        const actual = reference.contrastDetection![index];
        if (actual === null || typeof actual !== 'object') return false;
        if (actual.model !== entry.model || actual.mismatches !== entry.mismatches) return false;
        if (!Number.isInteger(actual.total) || actual.total < actual.mismatches || actual.total > entry.total) {
          return false;
        }
        const pValue = contrastDetectionPValue(actual.mismatches, actual.total, p0);
        return typeof actual.pValue === 'number'
          && Math.abs(actual.pValue - pValue) <= 1e-12
          && actual.detected === pValue < evidence.alpha;
      });
    if (!consistent) throw new Error('contrastDetection is inconsistent with the contrasts and self-test baseline');
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
  if (!KBF_READABLE_PARSER_VERSIONS.includes(profile.parserVersion)) throw new Error('parser version mismatch');
  if (profile.probesPerRequest !== 10) throw new Error('query profile must use ten probes per request');
  positiveInteger(profile.maxTokensPerRequest, 'maxTokensPerRequest');
  positiveInteger(profile.requestTimeoutMs, 'requestTimeoutMs');
  const settings = object(profile.generationSettings, 'generationSettings');
  if (settings.topP !== 1 || settings.seed !== null || settings.responseFormat !== 'text') {
    throw new Error('unsupported generation settings');
  }
  validateEndpointRequestFields(profile);
}

function validateCalibration(reference: KbfReferenceV1): void {
  const calibration = object(reference.calibration, 'calibration') as unknown as KbfReferenceCalibrationV1;
  if (calibration.version !== 1 || calibration.method !== KBF_CALIBRATION_METHOD) {
    throw new Error('unsupported calibration record');
  }
  positiveInteger(calibration.passes, 'calibration passes');
  if (!Number.isFinite(Date.parse(calibration.calibratedAt))) throw new Error('calibratedAt must be an ISO timestamp');
  const probesById = new Map(reference.probes.map((probe) => [probe.id, probe]));
  if (!Array.isArray(calibration.outcomes) || calibration.outcomes.length !== reference.probes.length) {
    throw new Error('calibration outcomes must contain exactly one entry per probe');
  }
  const seen = new Set<string>();
  for (const outcome of calibration.outcomes) {
    const probe = probesById.get(outcome?.probeId);
    if (!probe || seen.has(outcome.probeId)) throw new Error(`invalid or duplicate calibration outcome ${outcome?.probeId}`);
    seen.add(outcome.probeId);
    if (!Array.isArray(outcome.answers) || !Array.isArray(outcome.matches)
      || outcome.answers.length !== calibration.passes || outcome.matches.length !== calibration.passes) {
      throw new Error(`calibration outcome ${outcome.probeId} must have one answer and match per pass`);
    }
    for (const [pass, answer] of outcome.answers.entries()) {
      if (answer !== null && (typeof answer !== 'number' || !Number.isFinite(answer))) throw new Error('invalid calibration answer');
      if (outcome.matches[pass] !== scoreKbfAnswer(answer, probe)) {
        throw new Error(`calibration match for ${outcome.probeId} pass ${pass} is inconsistent with its answer`);
      }
    }
  }
  const recomputed = aggregateKbfSelfTestOutcomes(calibration.outcomes);
  if (calibration.hamming !== recomputed.hamming || calibration.total !== recomputed.total
    || calibration.coverage !== recomputed.coverage || calibration.errorRate !== recomputed.errorRate) {
    throw new Error('aggregate calibration is inconsistent with its per-probe outcomes');
  }
  if (!Array.isArray(calibration.batches)) throw new Error('calibration batches must be an array');
  for (let pass = 0; pass < calibration.passes; pass += 1) {
    const asked = calibration.batches.filter((batch) => batch.pass === pass);
    const ids = asked.flatMap((batch) => batch.probeIds);
    if (ids.length !== reference.probes.length || new Set(ids).size !== ids.length || ids.some((id) => !probesById.has(id))) {
      throw new Error(`calibration pass ${pass} must ask every probe exactly once`);
    }
    for (const batch of asked) {
      if (batch.probeIds.length > KBF_PROBES_PER_REQUEST
        || new Set(batch.probeIds.map((id) => probesById.get(id)!.domain)).size !== 1) {
        throw new Error(`calibration batch ${batch.batchIndex} must hold one domain and at most ${KBF_PROBES_PER_REQUEST} probes`);
      }
      getKbfPromptVariant(batch.promptVariantId);
    }
  }
}

function validateEndpointRequestFields(fields: Partial<ReferenceEndpointRequestV1>): void {
  if (fields.reasoningStrategy !== undefined
    && !KBF_REFERENCE_REASONING_STRATEGIES.includes(fields.reasoningStrategy)) {
    throw new Error('unsupported reasoning strategy');
  }
  if (fields.assistantPrefill !== undefined && fields.assistantPrefill !== KBF_THINKING_PREFILL) {
    throw new Error('unsupported assistant prefill');
  }
  if (fields.requestOverrides !== undefined) object(fields.requestOverrides, 'requestOverrides');
  if (fields.requestOmissions !== undefined) {
    if (!Array.isArray(fields.requestOmissions)
      || fields.requestOmissions.some((field) => !['temperature', 'top_p'].includes(field))
      || new Set(fields.requestOmissions).size !== fields.requestOmissions.length) {
      throw new Error('unsupported request omissions');
    }
  }
}

function validateReferenceEndpointRequest(reference: KbfReferenceV1): void {
  const recorded = reference.generator?.params?.referenceEndpointRequest;
  if (recorded === undefined) return;
  const request = object(recorded, 'generator.params.referenceEndpointRequest') as Partial<ReferenceEndpointRequestV1>;
  if (request.reasoningStrategy === undefined
    || request.requestOverrides === undefined
    || request.requestOmissions === undefined) {
    throw new Error('referenceEndpointRequest requires reasoningStrategy, requestOverrides, and requestOmissions');
  }
  validateEndpointRequestFields(request);
  const profile = reference.queryProfile;
  if (profile.reasoningStrategy !== undefined
    || profile.requestOverrides !== undefined
    || profile.requestOmissions !== undefined) {
    throw new Error('reference endpoint settings must not also appear in the query profile');
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
