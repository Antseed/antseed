import {
  KBF_AUDIT_VERIFY_OPTIONS,
  KBF_CALIBRATION_METHOD,
  KBF_CALIBRATION_PASSES,
  KBF_DEFAULT_PROMPT_VARIANT_ID,
  KBF_DEFAULT_SELF_TEST_RUNS,
  KBF_ENROLLMENT_TEMPERATURES,
  KBF_EXECUTION_TEMPERATURE,
  KBF_LOW_COVERAGE_RETRIES,
  KBF_PARSER_VERSION,
  KBF_PROBES_PER_REQUEST,
  KBF_REFERENCE_VERSION,
  canonicalHashBytes32,
  computeKbfVerdict,
  kbfPromptVariantsHash,
  parseKbfAnswers,
  scoreKbfAnswer,
  stripKbfThinkBlocks,
  type FingerprintStats,
  type KbfProbe,
  type MatchVector,
} from '@antseed/fingerprints'
import { modelHash, verifierVerdict } from '@antseed/node/payments'
import pkg from '../../package.json' with { type: 'json' }
import type { VerifierCLIConfig } from '../config/types.js'
import { assignAuditModelsRoundRobin, confirmationAssignments } from './audit-assignment.js'
import { auditHandovers } from './audit-handover.js'
import { MIN_SECONDS_FOR_ANOTHER_ROUND } from './audit-window.js'
import {
  AUDITOR_FAILURE_ATTEMPTS,
  CONFIRMATION_ATTEMPTS,
  CONFIRMATION_RECHECK_SPACING_SECONDS,
  SELLER_FAILURE_ATTEMPTS,
  SELLER_RETRY_SPACING_SECONDS,
} from './epoch-plan.js'
import { CALIBRATION_MINIMUM_COVERAGE, EPOCH_QUESTION_SET_METHOD } from './probe-bank.js'
import { AUDITED_MODELS, type AuditedModel } from './audited-models.js'
import { CLOSE_CALL_RULE_ID, closeCallRuleForExtensions, needsExtension, pooledCloseCallVerdict } from './close-call.js'
import { CANONICAL_KBF_DOMAINS } from './canonical-kbf-domains.js'
import { DEFAULT_LAYOUT_FILTER_PASSES, REFERENCE_BUILDER_VERSION, REFERENCE_SIZING_ALGORITHM_VERSION } from './model-reference.js'
import { pendingConfirmations, type EpochReport } from './pending-confirmations.js'
import {
  DEFAULT_REFERENCE_MAXIMUM_PROBE_COUNT,
  DEFAULT_REFERENCE_MINIMUM_PROBE_COUNT,
  DEFAULT_REFERENCE_MINIMUM_STATISTICAL_POWER,
  DEFAULT_REFERENCE_PROBE_STEP,
  REFERENCE_MAXIMUM_SELF_TEST_ERROR_RATE,
  REFERENCE_MINIMUM_MISMATCH_DELTA,
  REFERENCE_POWER_ALPHA,
  REFERENCE_POWER_CONFIDENCE,
} from './reference-sizing.js'

/**
 * Verifier compatibility: auditors running the same `compat` number split the models the same way
 * and judge sellers the same way, so their results line up in an epoch. It is
 * `antseedVerifier.compat` in the CLI's package.json, and is bumped only when the audit rules change
 * (`verifierRulesFingerprint`). `verifier run` and `submit` stop only when npm's latest CLI has a
 * higher one; any other new release is just an update notice. Release a bump at the end of an epoch,
 * so every auditor moves to the new rules at the same epoch start.
 */
export const VERIFIER_COMPAT: number = readCompat(pkg)
if (VERIFIER_COMPAT < 1) throw new Error('apps/cli/package.json needs antseedVerifier.compat')

/**
 * `antseedVerifier.compat` of a CLI package.json. A release from before verifier compat has none and
 * counts as 0 (older than every release that has one); a malformed value throws.
 */
export function readCompat(manifest: unknown): number {
  const block = (manifest as { antseedVerifier?: { compat?: unknown } } | null)?.antseedVerifier
  if (block === undefined) return 0
  const compat = block?.compat
  if (typeof compat !== 'number' || !Number.isSafeInteger(compat) || compat < 0) {
    throw new Error('package.json has an invalid antseedVerifier.compat')
  }
  return compat
}

/** The default of `verifier.closeCallExtensions`: every extra set a close call may get. */
const CLOSE_CALL_EXTENSIONS = 2

/**
 * Config settings that change the audit rules, set away from the values the compat number stands
 * for. Auditors that differ on them judge sellers differently under the same compat, so `verifier
 * run` stops unless `--skip-version-check` is given.
 */
export function verifierRuleOverrides(config: VerifierCLIConfig | undefined): string[] {
  const pinned = [
    ['closeCallExtensions', config?.closeCallExtensions, CLOSE_CALL_EXTENSIONS],
    ['referenceSelfTestRuns', config?.referenceSelfTestRuns, KBF_DEFAULT_SELF_TEST_RUNS],
    ['referenceLayoutFilterPasses', config?.referenceLayoutFilterPasses, DEFAULT_LAYOUT_FILTER_PASSES],
  ] as const
  return pinned.flatMap(([name, value, expected]) => (
    value === undefined || value === expected ? [] : [`verifier.${name} is ${value}; these rules use ${expected}`]
  ))
}

const SAMPLE_AUDITORS = [
  '0x1000000000000000000000000000000000000001',
  '0x2000000000000000000000000000000000000002',
  '0x3000000000000000000000000000000000000003',
  '0x4000000000000000000000000000000000000004',
  '0x5000000000000000000000000000000000000005',
] as const
const SAMPLE_EPOCHS = [0, 1, 2, 3, 4, 30, 31] as const
const EPOCH_SECONDS = 86_400

/**
 * Everything that must be the same for every auditor in an epoch: the audited models (keys, upstream
 * ids, aliases, provider pins, contrasts), how questions are chosen (one set per epoch), the audit
 * window and retry rules (which sellers get a result), the reference, calibration and scoring settings,
 * the domain table and prompt variants, and what the assignment, confirmation, stand-in, parsing and
 * scoring rules give for fixed sample inputs (so a change to their code shows up, not only a change
 * to a constant). A test pins its hash for the current compat number.
 */
export function verifierRulesFingerprint(input: { auditedModels?: Readonly<Record<string, AuditedModel>> } = {}): unknown {
  const models = Object.entries(input.auditedModels ?? AUDITED_MODELS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, model]) => ({
      key,
      upstreamModel: model.upstreamModel,
      serviceAliases: [...(model.serviceAliases ?? [])].sort(),
      referenceProvider: [...(model.referenceProvider ?? [])],
      contrastModels: [...model.contrastModels].sort(),
    }))
  const keys = models.map((model) => model.key)
  const samples = SAMPLE_EPOCHS.flatMap((epoch) => [2, 3, 5].map((count) => {
    const auditors = SAMPLE_AUDITORS.slice(0, count)
    const input = { auditors, epoch, availableModels: keys }
    const startedAt = epoch * EPOCH_SECONDS
    const endsAt = startedAt + EPOCH_SECONDS
    // The first auditor audited its first model and reported a DIFF; nothing else happened yet.
    const assignment = assignAuditModelsRoundRobin(input)
    const firstModel = assignment[0]!.models[0]
    const audits = firstModel ? [{ modelHash: modelHash(firstModel), auditor: assignment[0]!.auditor }] : []
    const reports = new Map<string, EpochReport>(firstModel ? [['sample', {
      agentId: 1n, serviceHash: `0x${'11'.repeat(32)}`, modelHash: modelHash(firstModel), round: 0,
      byAuditor: new Map([[assignment[0]!.auditor, verifierVerdict('DIFF')]]),
      required: new Map([[verifierVerdict('DIFF'), 2]]),
    }]] : [])
    return {
      epoch,
      auditors: count,
      assignment: assignment.map((entry) => entry.models),
      confirmations: [...confirmationAssignments(input).values()],
      handovers: [0.49, 0.5, 0.75].map((fraction) => auditHandovers({
        ...input, audits, epochStartedAt: startedAt, epochEndsAt: endsAt, now: startedAt + Math.round(EPOCH_SECONDS * fraction),
      })),
      confirmers: [0.25, 0.5].map((fraction) => auditors.map((auditor) => pendingConfirmations({
        reports, epoch, epochStartedAt: startedAt, epochEndsAt: endsAt, now: startedAt + Math.round(EPOCH_SECONDS * fraction),
        auditor, auditors, auditedModels: keys,
      }).map((entry) => ({ model: entry.model, confirmer: entry.confirmer, mine: entry.mine })))),
    }
  }))
  return {
    models,
    reference: {
      builderVersion: REFERENCE_BUILDER_VERSION,
      sizingAlgorithmVersion: REFERENCE_SIZING_ALGORITHM_VERSION,
      minimumProbeCount: DEFAULT_REFERENCE_MINIMUM_PROBE_COUNT,
      maximumProbeCount: DEFAULT_REFERENCE_MAXIMUM_PROBE_COUNT,
      probeStep: DEFAULT_REFERENCE_PROBE_STEP,
      minimumStatisticalPower: DEFAULT_REFERENCE_MINIMUM_STATISTICAL_POWER,
      minimumMismatchDelta: REFERENCE_MINIMUM_MISMATCH_DELTA,
      powerAlpha: REFERENCE_POWER_ALPHA,
      powerConfidence: REFERENCE_POWER_CONFIDENCE,
      maximumSelfTestErrorRate: REFERENCE_MAXIMUM_SELF_TEST_ERROR_RATE,
      layoutFilterPasses: DEFAULT_LAYOUT_FILTER_PASSES,
    },
    calibration: {
      method: KBF_CALIBRATION_METHOD,
      passes: KBF_CALIBRATION_PASSES,
      minimumCoverage: CALIBRATION_MINIMUM_COVERAGE,
      // Only coverage stops a model, and epoch sets reach the power on the calibration's trials.
      stopsOnRate: false,
      sizedOnCalibrationTrials: true,
    },
    domains: CANONICAL_KBF_DOMAINS.map(({ key, range, tolerance, template }) => ({ key, range, tolerance, template })),
    kbf: {
      referenceVersion: KBF_REFERENCE_VERSION,
      parserVersion: KBF_PARSER_VERSION,
      probesPerRequest: KBF_PROBES_PER_REQUEST,
      enrollmentTemperatures: [...KBF_ENROLLMENT_TEMPERATURES],
      executionTemperature: KBF_EXECUTION_TEMPERATURE,
      selfTestRuns: KBF_DEFAULT_SELF_TEST_RUNS,
      promptVariant: KBF_DEFAULT_PROMPT_VARIANT_ID,
      promptVariantsHash: kbfPromptVariantsHash(),
      lowCoverageRetries: KBF_LOW_COVERAGE_RETRIES,
      auditVerifyOptions: KBF_AUDIT_VERIFY_OPTIONS,
      closeCallExtensions: CLOSE_CALL_EXTENSIONS,
    },
    parsed: SAMPLE_REPLIES.map(([reply, count]) => parseKbfAnswers(stripKbfThinkBlocks(reply), count)),
    scored: SAMPLE_SCORES.map(([answer, domain, consensus]) => scoreKbfAnswer(answer, sampleProbe(domain, consensus))),
    verdicts: sampleVerdicts(),
    questions: { selection: EPOCH_QUESTION_SET_METHOD },
    window: {
      minimumSecondsLeftToOpen: MIN_SECONDS_FOR_ANOTHER_ROUND,
      sellerFailureAttempts: SELLER_FAILURE_ATTEMPTS,
      sellerRetrySpacingSeconds: SELLER_RETRY_SPACING_SECONDS,
      auditorFailureAttempts: AUDITOR_FAILURE_ATTEMPTS,
      confirmationAttempts: CONFIRMATION_ATTEMPTS,
      confirmationRecheckSpacingSeconds: CONFIRMATION_RECHECK_SPACING_SECONDS,
    },
    samples,
  }
}

export function verifierRulesHash(input: Parameters<typeof verifierRulesFingerprint>[0] = {}): string {
  return canonicalHashBytes32(verifierRulesFingerprint(input))
}

/** Replies that take the parser's different paths, with the probes asked: a change to how it reads them shows up. */
const SAMPLE_REPLIES: ReadonlyArray<readonly [string, number]> = [
  ['(1) 1934\n(2) 52\n(3) 7', 3],
  ['1) -40\n2) 1,250\n3. 3.2e5', 3],
  ['(1) −78.5\n(2) 9.81 m/s^2\n(3) 3.2 × 10^5', 3],
  ['Q1: 12\nQ2: 14', 2],
  ['126\n57\n98', 3],
  ['3.14\n2.71', 2],
  ['<think>(1) 5</think>\n(1) 6', 1],
  ['(1) ran from 1923 to 1924', 1],
  ['(1) 10–20', 1],
  ['I am not sure', 2],
]

/** Answers around the rounding and tolerance edges of each kind of domain. */
const SAMPLE_SCORES: ReadonlyArray<readonly [number | null, string, number]> = [
  [100, 'biology', 100],
  [100.4, 'biology', 100],
  [null, 'biology', 100],
  [2001, 'biology', 100],
  [503, 'chemistry_bp', 500],
  [504, 'chemistry_bp', 500],
  [1.02, 'physics', 1],
  [1.03, 'physics', 1],
  [11, 'medical', 10],
  [11.5, 'medical', 10],
]

function sampleProbe(domain: string, consensus: number): KbfProbe {
  const { range, tolerance, template } = CANONICAL_KBF_DOMAINS.find((entry) => entry.key === domain)!
  return { id: `sample-${domain}`, name: 'sample', domain, template, consensus, range: [...range], tolerance }
}

const SAMPLE_PROBES = 100
const SAMPLE_SELF_HAMMING = 2
const SAMPLE_MISMATCHES = [0, 2, 4, 6, 8, 10, 12, 15, 20, 30] as const
const SAMPLE_SCORED = [100, 85, 60, 40] as const

/** The first look at a set of `SAMPLE_PROBES` answers: `scored` of them scored, `mismatches` of those wrong. */
function sampleLook(scored: number, mismatches: number): { verdict: string; stats: FingerprintStats } {
  const vector: MatchVector = Array.from({ length: SAMPLE_PROBES }, (_, index) => (
    index >= scored ? null : index < mismatches ? 0 : 1
  ))
  const { verdict, stats } = computeKbfVerdict({ selfHamming: SAMPLE_SELF_HAMMING, selfTotal: SAMPLE_PROBES, targetMatchVector: vector, ...KBF_AUDIT_VERIFY_OPTIONS })
  return { verdict, stats: { ...stats, selfCoverage: 1 } }
}

/**
 * What an audit decides for fixed answer sets: the first look's verdict, whether it is a close call
 * that gets extra questions, and the pooled verdict after one or two extra sets. Only verdicts go in,
 * not p-values, so a numerically equivalent refactor keeps the hash.
 */
function sampleVerdicts(): unknown {
  return {
    closeCallRule: closeCallRuleForExtensions(2),
    firstLooks: SAMPLE_SCORED.flatMap((scored) => SAMPLE_MISMATCHES.filter((mismatches) => mismatches <= scored).map((mismatches) => {
      const { verdict, stats } = sampleLook(scored, mismatches)
      return { scored, mismatches, verdict, closeCall: needsExtension({ decisionRule: CLOSE_CALL_RULE_ID, stats }) }
    })),
    pooled: SAMPLE_MISMATCHES.flatMap((firstMismatches) => [[4], [10], [4, 6], [10, 12]].map((extraMismatches) => {
      const pooled = pooledCloseCallVerdict(
        { stats: sampleLook(SAMPLE_PROBES, firstMismatches).stats, probeCount: SAMPLE_PROBES },
        extraMismatches.map((mismatches) => ({ stats: sampleLook(SAMPLE_PROBES, mismatches).stats, probeCount: SAMPLE_PROBES })),
      )
      return { firstMismatches, extraMismatches, verdict: pooled.verdict, extend: pooled.extend }
    })),
  }
}
