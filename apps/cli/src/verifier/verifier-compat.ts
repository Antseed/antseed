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
import { encodeHttpResponse } from '@antseed/node'
import { PROBE_GUARD_RANGES, isSafeProbe, modelHash, signedResponseInputUsage, verifierVerdict } from '@antseed/node/payments'
import pkg from '../../package.json' with { type: 'json' }
import type { VerifierCLIConfig } from '../config/types.js'
import { assignAuditModelsRoundRobin, confirmationAssignments } from './audit-assignment.js'
import { MINIMUM_REAL_RESULTS_PERCENT, auditHandovers } from './audit-handover.js'
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
import { DIFF_HOLD_EPOCHS, diffHoldReason, diffHoldResultReason } from './diff-hold.js'
import { DEFAULT_LAYOUT_FILTER_PASSES, REFERENCE_SIZING_ALGORITHM_VERSION } from './model-reference.js'
import { REFERENCE_BUILDER_VERSION } from './reference-version.js'
import {
  REFERENCE_PROBE_TRIES,
  SELLER_REQUEST_TRIES,
  TOKENIZER_PRECHECK_RULE,
  generateTokenizerProbe,
  judgeTokenizerPrecheck,
  referenceDelta,
  tokenizerCrowd,
  tokenizerCrowdObjection,
  type TokenizerReferenceAskV1,
} from './tokenizer-precheck.js'
import { CONFIRMATION_WINDOW_SECONDS, pendingConfirmations, type EpochReport } from './pending-confirmations.js'
import {
  OUTPUT_CAP_RULE,
  classifyCapAnswer,
  judgeOutputCap,
  numberWords,
  outputCapLimit,
  outputCapPrompt,
  type OutputCapClass,
} from './output-cap.js'
import { SIGNED_REQUEST_TRIES } from './signed-seller-request.js'
import { ECHO_CROWD_TIME_LIMIT_MS, OUTPUT_ECHO_RULE, echoCrowdObjection, judgeEchoRound, outputEchoPrompt } from './output-echo.js'
import { AUDIT_CHECK_IDS, type AuditCheckId } from './flagging-checks.js'
import { CONFIRMATION_MIN_DELAY_SECONDS, decide } from './same-check.js'
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
 * higher one; any other new release is just an update notice.
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
    ['diffHoldEpochs', config?.diffHoldEpochs, DIFF_HOLD_EPOCHS],
    ['tokenizerPrecheck', config?.tokenizerPrecheck, true],
    ['outputChecks', config?.outputChecks, true],
    ['referenceSelfTestRuns', config?.referenceSelfTestRuns, KBF_DEFAULT_SELF_TEST_RUNS],
    ['referenceLayoutFilterPasses', config?.referenceLayoutFilterPasses, DEFAULT_LAYOUT_FILTER_PASSES],
    ['referenceMinimumProbeCount', config?.referenceMinimumProbeCount, DEFAULT_REFERENCE_MINIMUM_PROBE_COUNT],
    ['referenceMaximumProbeCount', config?.referenceMaximumProbeCount, DEFAULT_REFERENCE_MAXIMUM_PROBE_COUNT],
    ['referenceProbeStep', config?.referenceProbeStep, DEFAULT_REFERENCE_PROBE_STEP],
    ['referenceMinimumStatisticalPower', config?.referenceMinimumStatisticalPower, DEFAULT_REFERENCE_MINIMUM_STATISTICAL_POWER],
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
      firstReportBlock: new Map([[verifierVerdict('DIFF'), 1]]),
      opinions: new Map([[assignment[0]!.auditor, verifierVerdict('DIFF')]]),
    }]] : [])
    return {
      epoch,
      auditors: count,
      assignment: assignment.map((entry) => entry.models),
      confirmations: [...confirmationAssignments(input).values()],
      handovers: [0.49, 0.5, 0.75].map((fraction) => auditHandovers({
        ...input, audits, epochStartedAt: startedAt, epochEndsAt: endsAt, now: startedAt + Math.round(EPOCH_SECONDS * fraction),
      })),
      revokedHandovers: auditHandovers({
        ...input, audits, revoked: new Set(auditors.slice(0, 1)), epochStartedAt: startedAt, epochEndsAt: endsAt, now: startedAt,
      }),
      confirmers: [0, 1, 2].map((turn) => auditors.map((auditor) => pendingConfirmations({
        reports, epoch, blockTimestamps: new Map([[1, startedAt]]), now: startedAt + turn * CONFIRMATION_WINDOW_SECONDS,
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
    // The pre-check before a seller's questions: its rule and retry limits, the probe guard's table, a probe
    // written from a fixed sequence (so the probe writer is part of the rules), and what the rule, the reference
    // agreement, the crowd, the probe guard and the signed-usage reader give for fixed inputs.
    tokenizerPrecheck: {
      rule: TOKENIZER_PRECHECK_RULE,
      referenceProbeTries: REFERENCE_PROBE_TRIES,
      sellerRequestTries: SELLER_REQUEST_TRIES,
      probeGuardRanges: PROBE_GUARD_RANGES,
      probes: SAMPLE_PROBE_SEEDS.map((seed) => generateTokenizerProbe(fixedSequence(seed))),
      judged: SAMPLE_TOKENIZER_ROUNDS.map((rounds) => judgeTokenizerPrecheck(rounds)),
      referenceDeltas: SAMPLE_REFERENCE_ASKS.map((asks) => referenceDelta(asks).delta),
      // Whether a seller off a reference of 119 in every round is a mismatch, next to the model's sellers'
      // first-round differences: they must back the reference and must not outvote it.
      crowds: SAMPLE_TOKENIZER_CROWDS.map((deltas) => {
        const crowd = tokenizerCrowd(deltas, 119)
        return [crowd.corroborated, crowd.outvoted, tokenizerCrowdObjection(crowd, 119) === null]
      }),
      guarded: SAMPLE_PROBE_TEXTS.map((text) => isSafeProbe(text)),
      signedUsage: SAMPLE_USAGE_BODIES.map((body) => signedResponseInputUsage(encodeHttpResponse({
        requestId: 'sample', statusCode: 200, headers: {}, body: new TextEncoder().encode(body),
      }))),
    },
    // The cap check: its rule, a request written from a fixed sequence, and the class and outcome it gives for
    // fixed answers (billed, itemised reasoning, measured length) on a limit of 16.
    outputCap: {
      rule: OUTPUT_CAP_RULE,
      signedRequestTries: SIGNED_REQUEST_TRIES,
      limit: outputCapLimit(OUTPUT_CAP_RULE, fixedSequence(7)),
      prompt: outputCapPrompt(fixedSequence(11)).prompt,
      words: [101, 342, 999].map(numberWords),
      classes: SAMPLE_CAP_ANSWERS.map(([billed, reasoning, measured]) => classifyCapAnswer({
        cap: 16, oneAnswer: true, stops: false, billedOutputTokens: billed, estimated: false, reasoningTokens: reasoning,
        reasoningMarker: reasoning !== null, text: 'x', finished: false, shape: 'chat',
      }, 16, measured)),
      judged: SAMPLE_CAP_ASKS.map((classes) => judgeOutputCap(classes.map((entry) => ({ class: entry }))).outcome),
    },
    // The echo check: its rule, the request, and what a round and the crowd give for fixed counts (reference 60 and
    // 360 tokens), so a change to how either is judged changes the hash.
    outputEcho: {
      rule: OUTPUT_ECHO_RULE,
      crowdTimeLimitMs: ECHO_CROWD_TIME_LIMIT_MS,
      prompt: outputEchoPrompt('sample text'),
      rounds: SAMPLE_ECHO_ROUNDS.map((asks) => {
        const echo = (count: number | null) => ({ request: {} as never, reading: null, reply: { count, reasoning: 0, unusable: count === null ? 'sample' : null } })
        return judgeEchoRound({
          short: asks.map(([short]) => echo(short)), long: asks.map(([, long]) => echo(long)),
          reference: { short: 60, long: 360 }, referenceReasoning: 0, mode: 'plain',
        }).verdict
      }),
      crowd: SAMPLE_ECHO_CROWDS.map(([amount, votes, ownSpread]) => echoCrowdObjection(amount, votes, ownSpread) === null),
    },
    // A result that answers another auditor's waiting DIFF: sent as DIFF only when one of these checks flagged in
    // both, as SAME only when a check that flagged there passed here, otherwise not at all; made at least
    // `minDelaySeconds` after that report. What the rule gives for fixed checks (flagged, passed, verdict).
    confirmation: {
      checks: AUDIT_CHECK_IDS,
      minDelaySeconds: CONFIRMATION_MIN_DELAY_SECONDS,
      decisions: SAMPLE_CONFIRMATIONS.map(([firstChecks, flaggedBy, passedBy, verdict]) => decide(
        { agentId: 1n, serviceHash: '0x00', verdict: verifierVerdict(verdict), auditedAt: 10_000 + CONFIRMATION_MIN_DELAY_SECONDS, flaggedBy, passedBy },
        [{ auditor: '0x00', evidenceUri: 'ipfs://sample', evidenceHash: '0x00', reportedAt: 10_000, checks: firstChecks }],
      ).kind),
    },
    window: {
      minimumSecondsLeftToOpen: MIN_SECONDS_FOR_ANOTHER_ROUND,
      sellerFailureAttempts: SELLER_FAILURE_ATTEMPTS,
      sellerRetrySpacingSeconds: SELLER_RETRY_SPACING_SECONDS,
      auditorFailureAttempts: AUDITOR_FAILURE_ATTEMPTS,
      confirmationAttempts: CONFIRMATION_ATTEMPTS,
      confirmationWindowSeconds: CONFIRMATION_WINDOW_SECONDS,
      minimumRealResultsPercent: MINIMUM_REAL_RESULTS_PERCENT,
      confirmationRecheckSpacingSeconds: CONFIRMATION_RECHECK_SPACING_SECONDS,
      // Which epochs after a DIFF recorded in epoch 10 hold the seller (and that a SAME holds nobody).
      diffHoldEpochs: DIFF_HOLD_EPOCHS,
      diffHold: [10n, 11n, 12n, 13n].map((epoch) => [
        diffHoldReason({ verdict: verifierVerdict('DIFF'), epoch: 10n }, epoch, DIFF_HOLD_EPOCHS) !== null,
        diffHoldReason({ verdict: verifierVerdict('SAME'), epoch: 10n }, epoch, DIFF_HOLD_EPOCHS) !== null,
      ]),
      // Which results for a service whose DIFF is from epoch 10 are sent in epoch 11: a repeat DIFF is.
      diffHoldResults: (['SAME', 'DIFF', 'UNDETERMINED'] as const).map((result) => (
        diffHoldResultReason({ verdict: verifierVerdict('DIFF'), epoch: 10n }, 11n, DIFF_HOLD_EPOCHS, verifierVerdict(result)) !== null
      )),
    },
    samples,
  }
}

export function verifierRulesHash(input: Parameters<typeof verifierRulesFingerprint>[0] = {}): string {
  return canonicalHashBytes32(verifierRulesFingerprint(input))
}

/**
 * Pre-check rounds (the reference's difference, then the seller's for each ask) around the tolerance: a match on
 * the first or the second ask, three rounds off, a match after two rounds off, too few rounds, an ask without a
 * count, a seller whose two asks disagree, a round without a reference, and counts with cached input (one that
 * matches, one that is off).
 */
const SAMPLE_TOKENIZER_ROUNDS: ReadonlyArray<ReadonlyArray<{ referenceDelta: number | null; sellerDeltas: Array<number | null>; cachedAsks?: boolean[] }>> = [
  [{ referenceDelta: 100, sellerDeltas: [100] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 102] }],
  [{ referenceDelta: 100, sellerDeltas: [103, 104] }, { referenceDelta: 90, sellerDeltas: [87, 86] }, { referenceDelta: 80, sellerDeltas: [120, 120] }],
  [{ referenceDelta: 100, sellerDeltas: [103, 104] }, { referenceDelta: 90, sellerDeltas: [87, 86] }, { referenceDelta: 80, sellerDeltas: [120, 82] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 140] }, { referenceDelta: 90, sellerDeltas: [130, 130] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 140] }, { referenceDelta: 90, sellerDeltas: [130, null] }, { referenceDelta: 80, sellerDeltas: [120, 120] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 143] }, { referenceDelta: 90, sellerDeltas: [130, 130] }, { referenceDelta: 80, sellerDeltas: [120, 120] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 140] }, { referenceDelta: 90, sellerDeltas: [130, 130] }, { referenceDelta: 80, sellerDeltas: [120] }],
  [{ referenceDelta: null, sellerDeltas: [140, 140] }, { referenceDelta: 90, sellerDeltas: [130, 130] }, { referenceDelta: 80, sellerDeltas: [120, 120] }],
  [{ referenceDelta: 100, sellerDeltas: [101], cachedAsks: [true] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 140], cachedAsks: [false, true] }, { referenceDelta: 90, sellerDeltas: [130, 130] }, { referenceDelta: 80, sellerDeltas: [120, 120] }],
]

/**
 * Sellers' first-round differences: most on another count, a minority on another count, a tie, two sellers both
 * off, scattered counts, one seller alone, one seller off with one on the reference's count, one off with the
 * others unreadable, and two on another count against one on the reference's.
 */
const SAMPLE_TOKENIZER_CROWDS: ReadonlyArray<Array<number | null>> = [
  [132, 132, 133, 132, 119, 120, null],
  [132, 132, 132, 119, 119, 119, 118],
  [132, 132, 132, 119, 119, 119],
  [132, 132],
  [130, 133, 136, 119],
  [132],
  [132, 121],
  [132, null, null],
  [132, 132, 119],
]

const referenceAsk = (baseTokens: number | null, probedTokens: number | null, extra: Partial<TokenizerReferenceAskV1> = {}): TokenizerReferenceAskV1 => ({
  baseTokens, probedTokens, cachedInput: false, providers: ['Provider-A', 'Provider-A'], ...extra,
})

/**
 * Reference asks (input tokens for A and for A + B): agreeing, disagreeing, unreadable, not growing, asked once,
 * with cached input, from two providers, and from an endpoint that names no provider.
 */
const SAMPLE_REFERENCE_ASKS: ReadonlyArray<TokenizerReferenceAskV1[]> = [
  [referenceAsk(26, 143), referenceAsk(26, 143)],
  [referenceAsk(26, 143), referenceAsk(26, 144)],
  [referenceAsk(26, 143), referenceAsk(null, 143)],
  [referenceAsk(26, 26), referenceAsk(26, 26)],
  [referenceAsk(26, 143)],
  [referenceAsk(26, 143), referenceAsk(26, 143, { cachedInput: true })],
  [referenceAsk(26, 143), referenceAsk(26, 143, { providers: ['Provider-A', 'Provider-B'] })],
  [referenceAsk(26, 143, { providers: [null, null] }), referenceAsk(26, 143, { providers: [null, null] })],
]

/** Seeds of the probes the fingerprint holds, each written from `fixedSequence`. */
const SAMPLE_PROBE_SEEDS: readonly number[] = [1, 2, 3, 4]

/** A fixed sequence of picks in place of the probe writer's random ones. */
function fixedSequence(seed: number): (max: number) => number {
  let state = seed >>> 0
  return (max) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return Math.floor((state / 0x1_0000_0000) * max)
  }
}

/** Probe text on both sides of the probe guard. */
const SAMPLE_PROBE_TEXTS: readonly string[] = [
  ' The reference is ZX-48217-QK and I paid 1,249.50 € on 14 March 2026 😀',
  ' 예약 번호는 AB-12345-CD 이고 요금은 59,800원 입니다',
  ' 予約番号は AB-12345-CD で、料金は 9,800円です。',
  'No leading space',
  ' it\'s a contraction',
  ' a <|control|> token',
  ' ESPAÑA in capitals',
  ' thumbs up 👍\u{1f3fb}',
]

/** Signed response bodies the usage reader reads, and ones it refuses. */
/** A seller's short and long counts per ask, against a reference of 60 and 360 tokens. */
const SAMPLE_ECHO_ROUNDS: ReadonlyArray<ReadonlyArray<readonly [number | null, number | null]>> = [
  [[60, 360]], [[63, 363]], [[61, 366], [61, 366]], [[61, 366], [60, 360]], [[61, 366], [61, 380]], [[61, 366]], [[null, 360]],
]

/** A flagged amount, the other sellers' votes, the seller's own spread. */
const SAMPLE_ECHO_CROWDS: ReadonlyArray<readonly [number, ReadonlyArray<number | null>, number]> = [
  [93, [0, 1, -1, 0], 15], [93, [0, 1], 0], [93, [0, 9, 12, null], 0], [93, [0, 0, 92], 0], [60, [0, 0, 30], 0], [93, [0, 1, -1, 0], 35],
]

/** First auditor's checks, the checks that flagged and passed here, and the verdict here. */
const SAMPLE_CONFIRMATIONS: ReadonlyArray<readonly [AuditCheckId[], AuditCheckId[], AuditCheckId[], 'SAME' | 'DIFF' | 'UNDETERMINED']> = [
  [['tokens'], ['tokens'], [], 'DIFF'],
  [['kbf'], ['tokens'], [], 'DIFF'],
  [['kbf'], ['tokens', 'kbf'], [], 'DIFF'],
  [['tokens'], [], ['tokens', 'kbf'], 'SAME'],
  [['tokens'], [], ['kbf'], 'SAME'],
  [['output-cap'], ['output-cap'], [], 'DIFF'],
  [['kbf'], ['tokens'], [], 'UNDETERMINED'],
  [['tokens'], [], [], 'UNDETERMINED'],
]

/** Billed output, itemised reasoning and measured answer length of sample answers on a limit of 16. */
const SAMPLE_CAP_ANSWERS: ReadonlyArray<readonly [number, number | null, number | null]> = [
  [16, null, null], [18, null, null], [408, 392, 9], [927, null, 6], [40, null, 30], [60, 10, 33], [927, null, 537], [927, 920, 537],
]

const SAMPLE_CAP_ASKS: ReadonlyArray<readonly OutputCapClass[]> = [
  ['within'], ['unread'], ['cap-ignored'], ['cap-ignored', 'within'], ['cap-ignored', 'unread'], ['cap-ignored', 'cap-ignored'],
]

const SAMPLE_USAGE_BODIES: readonly string[] = [
  '{"usage":{"prompt_tokens":143,"completion_tokens":40}}',
  '{"usage":{"input_tokens":12,"cache_read_input_tokens":3,"cache_creation_input_tokens":1}}',
  '{"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":4}}}',
  '{"usage":{"prompt_tokens":15,"prompt_tokens":20}}',
  '{"usage":{"prompt_tokens":1e3}}',
  '{"usage":{"prompt_tokens":0,"completion_tokens":0}}',
  '{"usage":{"prompt_tokens":120,"prompt_tokens_details":{"cached_tokens":108}}}',
  '{"usage":{"prompt_tokens":802,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":770}}}',
  '{"choices":[]}',
  '{"usage":{"prompt_tokens":0,"prompt_tokens_details":{"cached_tokens":12}}}',
  '{"usage":{"prompt_tokens":123}',
  'data: {"usage":{"prompt_tokens":15}}',
  '{"error":{"message":"upstream overloaded"},"usage":{"prompt_tokens":40}}',
]

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
