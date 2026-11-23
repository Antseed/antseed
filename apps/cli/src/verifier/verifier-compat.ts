import {
  KBF_AUDIT_VERIFY_OPTIONS,
  THINKING_DISCOVERY_RULE,
  KBF_COVERAGE_RULE,
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
import { MINIMUM_REAL_RESULTS_PERCENT, auditHandovers } from './audit-handover.js'
import { MIN_SECONDS_FOR_ANOTHER_ROUND } from './audit-window.js'
import { confirmationsHoldingSubmit } from './confirmation-hold.js'
import {
  AUDITOR_FAILURE_ATTEMPTS,
  CONFIRMATION_ATTEMPTS,
  CONFIRMATION_RECHECK_SPACING_SECONDS,
  SELLER_FAILURE_ATTEMPTS,
  SELLER_RETRY_SPACING_SECONDS,
  type EpochCell,
} from './epoch-plan.js'
import type { ModelVerificationTargetResult } from './model-run.js'
import { CALIBRATION_MINIMUM_COVERAGE, EPOCH_QUESTION_SET_METHOD } from './probe-bank.js'
import { AUDITED_MODELS, type AuditedModel } from './audited-models.js'
import { CLOSE_CALL_RULE_ID, auditDecision, closeCallRuleForExtensions, needsExtension, pooledCloseCallVerdict } from './close-call.js'
import { CANONICAL_KBF_DOMAINS } from './canonical-kbf-domains.js'
import { DIFF_HOLD_EPOCHS, diffHoldReason, diffHoldResultReason } from './diff-hold.js'
import { DEFAULT_LAYOUT_FILTER_PASSES, REFERENCE_SIZING_ALGORITHM_VERSION } from './model-reference.js'
import { REFERENCE_BUILDER_VERSION } from './reference-version.js'
import { CONFIRMATION_WINDOW_SECONDS, pendingConfirmations, type EpochReport } from './pending-confirmations.js'
import {
  ALL_TESTS_FORMAT, AUDIT_CHECK_IDS, confirmationCannotDecideOnRetry, decidedRecords, sameConfirmation, verdictOf,
  type AuditCheckId, type CheckOutcome, type CheckSlot, type ConfirmationIdentity,
} from './audit-checks.js'
import { METHODS } from './methods/index.js'
import { FLIPS_RULE } from './methods/flips/flips-score.js'
import { FLIPS_AUDITOR_FAILURE } from './methods/flips/flips.js'
import { CONFIRMATION_MIN_DELAY_SECONDS, decide } from './same-check.js'
import { failureBlame } from './failure-blame.js'
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
  // The tests' switches from the list, in its order. Tests behind one switch are one setting, named once.
  const switches = new Map(METHODS.map((check) => [check.toggle.key, check.toggle.pinned] as const))
  const pinned = [
    ['closeCallExtensions', config?.closeCallExtensions, CLOSE_CALL_EXTENSIONS],
    ['diffHoldEpochs', config?.diffHoldEpochs, DIFF_HOLD_EPOCHS],
    ...[...switches].map(([key, expected]) => [key, config?.[key], expected] as const),
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
      // How thinking discovery chooses a setting, for the reference and for every seller audited.
      thinkingDiscoveryRule: THINKING_DISCOVERY_RULE,
    },
    parsed: SAMPLE_REPLIES.map(([reply, count]) => parseKbfAnswers(stripKbfThinkBlocks(reply), count)),
    scored: SAMPLE_SCORES.map(([answer, domain, consensus]) => scoreKbfAnswer(answer, sampleProbe(domain, consensus))),
    verdicts: sampleVerdicts(),
    questions: { selection: EPOCH_QUESTION_SET_METHOD },
    // Each test's own block under its slot's name (`RecordCheck.fingerprint`): its rule, its limits and what its judge
    // gives for fixed inputs, kept with the test. Under the same key, the samples of a rule that crosses tests.
    ...Object.fromEntries(METHODS.map((check) => [check.slot, { ...check.fingerprint(), ...CROSS_TEST_SAMPLES[check.slot]?.() }])),
    // A result that answers another auditor's waiting DIFF: sent as DIFF only when one of these checks flagged in
    // both, as SAME only when a check that flagged there passed here, otherwise not at all; made at least
    // `minDelaySeconds` after that report. What the rule gives for fixed checks (flagged, passed, verdict).
    confirmation: {
      checks: AUDIT_CHECK_IDS,
      minDelaySeconds: CONFIRMATION_MIN_DELAY_SECONDS,
      decisions: SAMPLE_CONFIRMATIONS.map(([firstChecks, flaggedBy, passedBy, verdict]) => decide(
        { agentId: 1n, serviceHash: '0x00', verdict: verifierVerdict(verdict), auditedAt: 10_000 + CONFIRMATION_MIN_DELAY_SECONDS, flaggedBy, passedBy },
        [{ auditor: '0x00', peerId: '00'.repeat(20), evidenceUri: 'ipfs://sample', evidenceHash: '0x00', reportedAt: 10_000, checks: firstChecks }],
      ).kind),
      // A confirmation is credited only to the report it names: its tests and the report's time.
      identity: SAMPLE_CONFIRMATION_IDENTITIES.map(([named]) => decide(
        { agentId: 1n, serviceHash: '0x00', verdict: verifierVerdict('DIFF'), auditedAt: 10_000 + CONFIRMATION_MIN_DELAY_SECONDS, flaggedBy: ['output-cap'], passedBy: [], confirming: named },
        [{ auditor: '0x00', peerId: '00'.repeat(20), evidenceUri: 'ipfs://sample', evidenceHash: '0x00', reportedAt: 100, checks: ['output-cap', 'kbf'] }],
      ).kind),
    },
    // The audit's verdict over every test (rule `all-tests-v1`): every test runs and none ends the audit; any flag is a
    // DIFF; otherwise the questions' own verdict; a test with no result never blocks SAME; a confirmation in which no
    // test it repeats decided is undecided. What the rule gives for fixed readings and questions verdicts.
    // What a scheduled retry carries (`decidedRecords`): only tests that decided, and a test judged against an earlier
    // one only with it.
    carry: SAMPLE_CARRIES.map((records) => Object.keys(decidedRecords(records as never)).sort()),
    // Into a confirmation only records of a confirmation of the same report and tests are carried (`sameConfirmation`).
    confirmationCarry: SAMPLE_CONFIRMATION_IDENTITIES.map(([left, right]) => sameConfirmation(left, right)),
    // A close call beside a cap flag, waiting and then closed: while it waits the questions give neither pass nor flag;
    // closed, its questions are undecided and the cap flag makes the audit a DIFF.
    closedCloseCall: [false, true].map((closed) => {
      const look = computeKbfVerdict({
        selfHamming: 30, selfTotal: 300, minCoverage: 0.5, minDiffCoverage: 0.8,
        targetMatchVector: Array.from({ length: 100 }, (_, index) => (index < 22 ? 0 : 1)),
      })
      const decision = auditDecision({
        status: look.verdict, questionsStatus: look.verdict, parsedProbeCount: 100, probeCount: 100, decisionRule: 'kbf-extension-v2',
        stats: { ...look.stats, selfCoverage: 1 }, responseAuthVerified: true, outcomeReason: null,
        outputCap: { outcome: 'flag' }, ...(closed ? { closeCallClosed: { reason: 'sample' } } : {}),
      } as never)
      return [decision.pending, decision.questionsStatus, decision.audit.verdict]
    }),
    verdict: {
      format: ALL_TESTS_FORMAT,
      decisions: SAMPLE_VERDICTS.map(([outcomes, questions, confirming, pending]) => {
        const readings = outcomes.map(([check, outcome]) => ({ check, subject: 'model' as const, outcome }))
        const verdict = verdictOf(readings, questions, confirming, { questionsPending: pending })
        return [verdict.verdict, verdict.flaggedBy, verdict.undecidedConfirmation]
      }),
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
      // Which started confirmations hold their model's submit, with a day left and just before the end-of-epoch cut-off.
      confirmationHoldsSubmit: [86_400, MIN_SECONDS_FOR_ANOTHER_ROUND - 1].map((secondsLeft) => SAMPLE_WAITING_CONFIRMATIONS.map((cell) => (
        confirmationsHoldingSubmit({ state: { cells: new Map([['cell', cell]]), manifests: [] }, secondsLeftInEpoch: secondsLeft, stillMine: null }).size > 0
      ))),
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
 * Samples of a rule that crosses tests, held in the fingerprint under one test's key beside the test's own block
 * (`RecordCheck.fingerprint`). They stay with the fingerprint because the rule sampled is not the test's own: the
 * same-check decision, a confirmation's retry over the list of tests, a failure's blame. A test's description that
 * called the same-check decision would also import itself back.
 */
const CROSS_TEST_SAMPLES: { readonly [Slot in CheckSlot]?: () => Record<string, unknown> } = {
  flips: () => ({
    // A waiting FLIPS flag is answered only by a confirmation of FLIPS: a first look's FLIPS flag or pass answers nothing.
    // A score between the bars clears like a pass, only on a confirmation of FLIPS (`confirmBetweenClears`).
    stageBound: [true, false].flatMap((confirms) => (['flag', 'pass', 'between'] as const).map((outcome) => {
      const decision = decide({
        agentId: 1n, serviceHash: '0x00', verdict: verifierVerdict(outcome === 'flag' ? 'DIFF' : 'SAME'), auditedAt: 10_000,
        flaggedBy: outcome === 'flag' ? ['flips'] : [], passedBy: outcome === 'pass' ? ['flips', 'kbf'] : ['kbf'],
        ...(outcome === 'between' ? { betweenBy: ['flips'] } : {}),
        ...(confirms ? { confirming: { checks: ['flips'], reportedAt: 1 } } : {}),
      }, [{ auditor: '0x00', peerId: '00'.repeat(20), evidenceUri: 'ipfs://x', evidenceHash: '0x00', reportedAt: 1, checks: ['flips'] }])
      return [confirms, outcome, decision.kind, decision.kind === 'exclude' ? decision.code : null]
    })),
    // A confirmation finished at once: only for a counting FLIPS of this rule scored between its bars.
    oneAttemptStop: [{ rule: FLIPS_RULE.id }, { rule: FLIPS_RULE.id, probe: true }, { rule: 'flips-unknown' }, { rule: FLIPS_RULE.id, p: null }].map((summary) => (
      confirmationCannotDecideOnRetry({
        status: 'UNDETERMINED', questionsStatus: 'SAME', parsedProbeCount: 1, confirming: ['flips'],
        flips: { model: 'claude-opus-5.5', stage: 'confirm', outcome: 'inconclusive', counted: true, p: 0.02, score: 4, reason: 'x', ...summary } as never,
      }))),
    // A FLIPS that cannot run is the auditor's failure; on the auditor's last attempt it is no result instead.
    auditorFailure: [FLIPS_AUDITOR_FAILURE, failureBlame(null, `${FLIPS_AUDITOR_FAILURE}: x`)],
  }),
}

/** Confirmation cells by attempt and plan action, each started (an attempt finished): which wait to be audited again. */
const SAMPLE_WAITING_CONFIRMATIONS: readonly EpochCell[] = ([
  [1, 'retry', 0], [2, 'retry', 0], [CONFIRMATION_ATTEMPTS, 'retry', 0], [1, 'done', 0], [1, 'extend', 0],
  // The auditor's own failures hold only up to its attempts.
  [0, 'retry', AUDITOR_FAILURE_ATTEMPTS - 1], [0, 'retry', AUDITOR_FAILURE_ATTEMPTS],
] as const).map(([attempts, action, auditorAttempts]) => ({
  model: 'm', peerId: 'aa', runId: 'r', state: action === 'extend' ? 'pending_extension' : 'undetermined', attempts, auditorAttempts,
  permanent: false, lastAttemptAt: 1, blame: 'seller', reason: null, skipCode: null, action,
  result: action === 'extend' ? null : { confirmsDiff: true } as ModelVerificationTargetResult,
  ...(action === 'extend' ? { pending: { confirmsDiff: true } as ModelVerificationTargetResult } : {}),
}))

/** First auditor's checks, the checks that flagged and passed here, and the verdict here. */
/** Fixed test records for what a retry carries. */
const SAMPLE_CONFIRMATION_IDENTITIES: ReadonlyArray<readonly [ConfirmationIdentity, ConfirmationIdentity]> = [
  [{ checks: ['output-cap', 'kbf'], reportedAt: 100 }, { checks: ['kbf', 'output-cap'], reportedAt: 100 }],
  [{ checks: ['output-cap'], reportedAt: 100 }, { checks: ['output-cap'], reportedAt: 101 }],
  [{ checks: ['output-cap'], reportedAt: 100 }, { checks: ['output-cap', 'flips'], reportedAt: 100 }],
  [{ checks: ['output-cap'] }, { checks: ['output-cap'] }],
]

const SAMPLE_CARRIES = [
  { tokenizerPrecheck: { outcome: 'match' }, outputCap: { outcome: 'inconclusive' } },
  { tokenizerPrecheck: { outcome: 'inconclusive' }, outputEcho: { outcome: 'pass', growth: { outcome: 'pass' }, fixedAmount: { outcome: 'pass' } } },
  { tokenizerPrecheck: { outcome: 'match' }, outputEcho: { outcome: 'pass', growth: { outcome: 'pass' }, fixedAmount: { outcome: 'pass' } } },
]

/** Fixed readings for the verdict rule: test outcomes, the questions' verdict, the tests confirmed, questions pending. */
const SAMPLE_VERDICTS: ReadonlyArray<readonly [
  ReadonlyArray<readonly [AuditCheckId, CheckOutcome]>, 'SAME' | 'DIFF' | 'UNDETERMINED', AuditCheckId[] | null, boolean,
]> = [
  [[['tokens', 'pass'], ['output-cap', 'pass'], ['output-echo', 'pass'], ['kbf', 'pass']], 'SAME', null, false],
  [[['tokens', 'inconclusive'], ['output-cap', 'not-run'], ['output-echo', 'inconclusive'], ['kbf', 'pass']], 'SAME', null, false],
  [[['tokens', 'pass'], ['output-cap', 'flag'], ['output-echo', 'pass'], ['kbf', 'pass']], 'SAME', null, false],
  [[['tokens', 'flag'], ['output-cap', 'flag'], ['kbf', 'flag']], 'DIFF', null, false],
  [[['tokens', 'pass'], ['kbf', 'inconclusive']], 'UNDETERMINED', null, false],
  [[['tokens', 'pass'], ['output-cap', 'inconclusive'], ['output-echo', 'flag'], ['kbf', 'pass']], 'SAME', ['output-cap'], false],
  [[['tokens', 'pass'], ['output-cap', 'pass'], ['kbf', 'pass']], 'SAME', ['output-cap'], false],
  [[['output-cap', 'flag'], ['kbf', 'inconclusive']], 'UNDETERMINED', ['kbf'], true],
  [[['output-cap', 'inconclusive'], ['kbf', 'pass']], 'SAME', ['output-cap', 'kbf'], false],
  [[['output-cap', 'inconclusive'], ['kbf', 'flag']], 'DIFF', ['output-cap', 'kbf'], false],
  [[['output-cap', 'flag'], ['kbf', 'inconclusive']], 'UNDETERMINED', ['kbf'], false],
]

const SAMPLE_CONFIRMATIONS: ReadonlyArray<readonly [AuditCheckId[], AuditCheckId[], AuditCheckId[], 'SAME' | 'DIFF' | 'UNDETERMINED']> = [
  // Two first flags: one passed here and one left open clears nothing; both passed clears; one flagged again confirms.
  [['output-cap', 'kbf'], [], ['kbf'], 'SAME'],
  [['output-cap', 'kbf'], [], ['output-cap', 'kbf'], 'SAME'],
  [['output-cap', 'kbf'], ['output-cap'], ['kbf'], 'DIFF'],
  [['tokens'], ['tokens'], [], 'DIFF'],
  [['kbf'], ['tokens'], [], 'DIFF'],
  [['kbf'], ['tokens', 'kbf'], [], 'DIFF'],
  [['tokens'], [], ['tokens', 'kbf'], 'SAME'],
  [['tokens'], [], ['kbf'], 'SAME'],
  [['output-cap'], ['output-cap'], [], 'DIFF'],
  [['kbf'], ['tokens'], [], 'UNDETERMINED'],
  [['tokens'], [], [], 'UNDETERMINED'],
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
    // Under the coverage a DIFF needs (60 of 100 scored, or 45), with and without the coverage rule new looks name, and a
    // pooled look of two such sets.
    coverageRule: KBF_COVERAGE_RULE,
    coverageLooks: [[60, 10], [60, 25], [60, 40], [45, 40]].map(([scored, mismatches]) => {
      const vector = Array.from({ length: 100 }, (_, index) => (index < mismatches! ? 0 : index < scored! ? 1 : null))
      const look = (coverageRule?: typeof KBF_COVERAGE_RULE) => computeKbfVerdict({
        selfHamming: SAMPLE_SELF_HAMMING, selfTotal: SAMPLE_PROBES, targetMatchVector: vector, ...KBF_AUDIT_VERIFY_OPTIONS, ...(coverageRule ? { coverageRule } : {}),
      }).verdict
      return { scored, mismatches, plain: look(), byRule: look(KBF_COVERAGE_RULE) }
    }),
    coveragePooled: [undefined, KBF_COVERAGE_RULE.id].map((coverageRule) => pooledCloseCallVerdict(
      { stats: { ...sampleLook(SAMPLE_PROBES, 12).stats, targetHamming: 12, targetTotal: 75 }, probeCount: SAMPLE_PROBES },
      [{ stats: { ...sampleLook(SAMPLE_PROBES, 30).stats, targetHamming: 30, targetTotal: 75 }, probeCount: SAMPLE_PROBES }],
      closeCallRuleForExtensions(2) ?? undefined, coverageRule,
    ).verdict),
  }
}
