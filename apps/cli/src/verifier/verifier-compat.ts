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
import { encodeHttpRequest, encodeHttpResponse } from '@antseed/node'
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
import { CLOSE_CALL_RULE_ID, auditDecision, closeCallRuleForExtensions, needsExtension, pooledCloseCallVerdict } from './close-call.js'
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
  cacheBlocks,
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
import { ECHO_CROWD_TIME_LIMIT_MS, OUTPUT_ECHO_RULE, echoCrowdObjection, judgeEchoRound, judgeOutputEcho, outputEchoPrompt } from './output-echo.js'
import { AUDIT_CHECK_IDS, type AuditCheckId } from './flagging-checks.js'
import { ALL_TESTS_FORMAT, FLIPS_CHECK, confirmationCannotDecideOnRetry, decidedRecords, sameConfirmation, verdictOf, type CheckOutcome, type ConfirmationIdentity } from './audit-checks.js'
import { FLIPS_REQUESTS, FLIPS_RULE, flipsCounts, flipsRequestBody, judgeFlipsCheck } from './flips-score.js'
import { FLIPS_REASK_BUDGET, FLIPS_REASONING_SHARE, FLIPS_REPLY_MAX_CHARS, FLIPS_REFERENCE_TIME_LIMIT_MS, FLIPS_SLOTS_AT_ONCE, FLIPS_TIME_LIMIT_MS, FLIPS_WORDS, drawFlipsPairs, flipsPool, flipsSeed, judgeFlips, flipsReferenceDecision, FLIPS_AUDITOR_FAILURE, type FlipsV1 } from './flips.js'
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
  const pinned = [
    ['closeCallExtensions', config?.closeCallExtensions, CLOSE_CALL_EXTENSIONS],
    ['diffHoldEpochs', config?.diffHoldEpochs, DIFF_HOLD_EPOCHS],
    ['tokenizerPrecheck', config?.tokenizerPrecheck, true],
    ['outputChecks', config?.outputChecks, true],
    ['flips', config?.flips, true],
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

/** The judge's branches, each one edit of a plain sample check (`sampleFlipsRecord`). */
type FlipsSampleEdit = (pair: { seller: Array<{ content: string; finishReason: string }>; reference: Array<{ content: string; finishReason: string }> }, index: number) => void
const SAMPLE_FLIPS_CHECKS: ReadonlyArray<readonly [string, FlipsSampleEdit]> = [
  ['plain', () => undefined],
  ['placeholders cut at the limit', (pair) => { for (const reply of pair.seller) Object.assign(reply, { content: '[No answer]', finishReason: 'length' }) }],
  ['seller replies without a sequence', (pair, index) => { if (index === 0) for (const reply of pair.seller.slice(0, 3)) reply.content = 'no.' }],
  ['reference replies without a sequence', (pair, index) => { if (index === 0) for (const reply of pair.reference.slice(0, 9)) reply.content = 'no.' }],
  ['repeated seller replies', (pair, index) => { if (index === 1) for (const reply of pair.seller.slice(1, 6)) reply.content = pair.seller[0]!.content }],
  ['an over-long reference reply', (pair, index) => { if (index === 0) pair.reference[0]!.content = 'amber '.repeat(1_100) }],
]

/** A first-stage FLIPS check of fixed replies, the seller's signed, edited by one sample, to judge under this build. */
function sampleFlipsRecord(edit: FlipsSampleEdit): Pick<FlipsV1, 'draw' | 'service' | 'referenceOneProvider' | 'pairs'> {
  const model = 'claude-opus-5.5'
  const draw = { auditor: '0x00', model, epoch: '1', seed: '00', stage: 'first' as const }
  // A fixed pseudo-random sequence per reply (xorshift32 from its seed): no two replies of a side repeat.
  const sequence = (seed: number, pair: readonly [string, string]) => {
    let state = (seed + 1) * 2_654_435_761 >>> 0
    return Array.from({ length: 64 }, () => {
      state ^= state << 13; state >>>= 0
      state ^= state >>> 17
      state ^= state << 5; state >>>= 0
      return pair[state & 1]
    }).join(' ')
  }
  const encoder = new TextEncoder()
  return {
    draw, service: model, referenceOneProvider: true,
    pairs: drawFlipsPairs(draw).map((words, pairIndex) => {
      const replies = {
        seller: Array.from({ length: FLIPS_RULE.repliesPerPair.first }, (_, index) => ({ content: sequence(index * 3 + 7 + pairIndex, words), finishReason: 'stop' })),
        reference: Array.from({ length: FLIPS_RULE.referenceRepliesPerPair }, (_, index) => ({ content: sequence(index + pairIndex * 50, words), finishReason: 'stop' })),
      }
      edit(replies, pairIndex)
      const body = flipsRequestBody(model, model, words)
      return {
        words,
        reference: {
          words,
          replies: replies.reference.map((reply) => ({ ...reply, provider: 'host', reasoning: false, thinkBlock: false, failure: null, request: JSON.stringify(body) })),
        },
        seller: replies.seller.map((reply, slot) => {
          const id = `sample-${pairIndex}-${slot}`
          const answer = { id, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply.content }, finish_reason: reply.finishReason }], usage: { prompt_tokens: 60, completion_tokens: 130 } }
          return {
            request: {
              requestIds: [id], statusCode: 200, failureReason: null,
              attemptCosts: [{ inputTokens: 60, outputTokens: 130, totalTokens: 190, estimatedCostUsd: 0 }],
              responseAuth: {
                requestId: id, status: 'verified', failureReason: null,
                record: { requestId: id, sellerPeerId: 'sample', advertisedService: model },
                signedPreimages: {
                  encoding: 'antseed-http-codec-v1', signatureEncoding: 'antseed-response-auth-signing-v1',
                  requestBase64: Buffer.from(encodeHttpRequest({ requestId: id, method: 'POST', path: '/v1/chat/completions', headers: {}, body: encoder.encode(JSON.stringify(body)) })).toString('base64'),
                  responseBase64: Buffer.from(encodeHttpResponse({ requestId: id, statusCode: 200, headers: {}, body: encoder.encode(JSON.stringify(answer)) })).toString('base64'),
                  responseAuthSigningBase64: 'AA==', requestHash: `0x${'44'.repeat(32)}`, responseHash: `0x${'55'.repeat(32)}`,
                },
              },
            } as never,
          }
        }),
      }
    }),
  }
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
      // A pair whose two answers report the same cached amount is kept (tokenizer-precheck-v3); different amounts, one
      // side only, or no stored cache are not.
      cacheCancels: [
        [{ cached_tokens: 64 }, { cached_tokens: 64 }], [{ cached_tokens: 64 }, { cached_tokens: 70 }], [{ cached_tokens: 64 }, undefined], [undefined, undefined],
      ].map(([base, probed]) => cacheBlocks({
        base: { cachedInput: base !== undefined, ...(base ? { cache: base } : {}) },
        probed: { cachedInput: probed !== undefined, ...(probed ? { cache: probed } : {}) },
      } as never)),
      cachedReference: referenceDelta([1, 2].map(() => ({
        baseTokens: 140, probedTokens: 157, cachedInput: true, cache: [{ cached_tokens: 128 }, { cached_tokens: 128 }] as [Record<string, number>, Record<string, number>], providers: ['Provider-A', 'Provider-A'] as [string, string],
      }))).delta,
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
      // Whole judgements, both modes and the fixed-amount gate: each sample is every text asked twice at the given
      // short and long counts, against three backing sellers at 0 and one at 1.
      judged: SAMPLE_ECHO_JUDGEMENTS.map(([mode, short, long, reasoning]) => {
        const echo = (count: number) => ({ request: {} as never, reading: null, reply: { count, reasoning, unusable: null } })
        const rounds = [0, 1, 2].map(() => {
          const asks = { short: [echo(short), echo(short)], long: [echo(long), echo(long)] }
          return { ...asks, ...judgeEchoRound({ ...asks, reference: { short: 60, long: 360 }, referenceReasoning: reasoning, mode }) }
        })
        const vote = (value: number) => ({ peerId: `sample-${value}`, short: echo(60), long: echo(360), growth: value, offset: value, reasoning: 0, sentHere: true })
        const judged = judgeOutputEcho({
          mode, rounds, precheckMatch: true, referenceReasoning: [reasoning, reasoning, reasoning],
          reference: [0, 1, 2].map(() => ({ short: { text: 's', count: 60 }, long: { text: 'l', count: 360 } })),
          crowd: { votes: [vote(0), vote(0), vote(0), vote(1)], incomplete: false },
        })
        return [judged.outcome, judged.growth.outcome, judged.fixedAmount.outcome]
      }),
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
      // A confirmation is credited only to the report it names: its tests and the report's time.
      identity: SAMPLE_CONFIRMATION_IDENTITIES.map(([named]) => decide(
        { agentId: 1n, serviceHash: '0x00', verdict: verifierVerdict('DIFF'), auditedAt: 10_000 + CONFIRMATION_MIN_DELAY_SECONDS, flaggedBy: ['output-cap'], passedBy: [], confirming: named },
        [{ auditor: '0x00', evidenceUri: 'ipfs://sample', evidenceHash: '0x00', reportedAt: 100, checks: ['output-cap', 'kbf'] }],
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
    // The randomness check (FLIPS): its rule (bars, pass, sizes, calibration, which models count), the eval's request of
    // each model, the word list and its two pools, and what a fixed draw gives.
    flips: {
      rule: FLIPS_RULE,
      requests: FLIPS_REQUESTS,
      words: FLIPS_WORDS,
      pools: [flipsPool('first'), flipsPool('confirm')],
      draw: (['first', 'confirm'] as const).map((stage) => drawFlipsPairs({ auditor: '0x00', model: 'sample', epoch: '1', seed: flipsSeed('00', { model: 'sample', epoch: '1', runId: 'r', stage }), stage })),
      reaskBudget: FLIPS_REASK_BUDGET,
      reasoningShare: FLIPS_REASONING_SHARE,
      replyMaxChars: FLIPS_REPLY_MAX_CHARS,
      // A follow-up draw leaves out its first check's pairs.
      followUpDraw: drawFlipsPairs({ auditor: '0x00', model: 'sample', epoch: '1', seed: '00', stage: 'confirm', probe: true, excluding: flipsPool('confirm').slice(0, 2) }),
      limits: [FLIPS_TIME_LIMIT_MS, FLIPS_SLOTS_AT_ONCE, FLIPS_REFERENCE_TIME_LIMIT_MS],
      // One scored sample through the scorer: fixed symbol strings on both sides of one pair each.
      scored: (() => {
        const seq = (seed: number) => Array.from({ length: 64 }, (_, index) => ((seed * 7 + index * index * 3 + index) % 5) % 2 ? 'basin' : 'amber').join(' ')
        const pairs = (['first', 'second'] as const).map((_, pairIndex) => ({
          pair: (pairIndex === 0 ? ['amber', 'basin'] : ['amber', 'basin']) as [string, string],
          reference: Array.from({ length: 40 }, (_, index) => ({ content: seq(index + pairIndex * 50), finishReason: 'stop' })),
          seller: Array.from({ length: 10 }, (_, index) => ({ content: seq(index * 3 + 7 + pairIndex), finishReason: 'stop' })),
        }))
        const judged = judgeFlipsCheck(pairs)
        return [judged.outcome, judged.score === null ? null : Number(judged.score.toFixed(9)), judged.p === null ? null : Number(judged.p.toExponential(6))]
      })(),
      counts: ['minimax-m3', 'claude-opus-5.5', 'unmeasured-model'].map((model) => flipsCounts(model)),
      // Counting by a record's own rule: a flips-v1 summary never counts under this build, a flips-v2 one does.
      countsByRule: ['flips-v1', FLIPS_RULE.id, 'flips-unknown'].map((rule) => FLIPS_CHECK.summaryCounts!({ rule, model: 'claude-opus-5.5', outcome: 'flag' })),
      // One judged record through each branch of the judge: placeholders cut at the limit, replies without a sequence on
      // either side, repeated replies, and an over-long reference reply left out.
      // A waiting FLIPS flag is answered only by a confirmation of FLIPS: a first look's FLIPS flag or pass answers nothing.
      // A score between the bars clears like a pass, only on a confirmation of FLIPS (`confirmBetweenClears`).
      stageBound: [true, false].flatMap((confirms) => (['flag', 'pass', 'between'] as const).map((outcome) => {
        const decision = decide({
          agentId: 1n, serviceHash: '0x00', verdict: verifierVerdict(outcome === 'flag' ? 'DIFF' : 'SAME'), auditedAt: 10_000,
          flaggedBy: outcome === 'flag' ? ['flips'] : [], passedBy: outcome === 'pass' ? ['flips', 'kbf'] : ['kbf'],
          ...(outcome === 'between' ? { betweenBy: ['flips'] } : {}),
          ...(confirms ? { confirming: { checks: ['flips'], reportedAt: 1 } } : {}),
        }, [{ auditor: '0x00', evidenceUri: 'ipfs://x', evidenceHash: '0x00', reportedAt: 1, checks: ['flips'] }])
        return [confirms, outcome, decision.kind, decision.kind === 'exclude' ? decision.code : null]
      })),
      // A confirmation finished at once: only for a counting FLIPS of this rule scored between its bars.
      oneAttemptStop: [{ rule: FLIPS_RULE.id }, { rule: FLIPS_RULE.id, probe: true }, { rule: 'flips-v1' }, { rule: FLIPS_RULE.id, p: null }].map((summary) => (
        confirmationCannotDecideOnRetry({
          status: 'UNDETERMINED', questionsStatus: 'SAME', parsedProbeCount: 1, confirming: ['flips'],
          flips: { model: 'claude-opus-5.5', stage: 'confirm', outcome: 'inconclusive', counted: true, p: 0.02, score: 4, reason: 'x', ...summary } as never,
        }))),
      // A FLIPS that cannot run is the auditor's failure; on the auditor's last attempt it is no result instead.
      auditorFailure: [FLIPS_AUDITOR_FAILURE, failureBlame(null, `${FLIPS_AUDITOR_FAILURE}: x`)],
      // What a stage's reference means for an audit, decided once per run before anything paid: run, not started, or run
      // with FLIPS at no result on the auditor's last attempt (never for a report only FLIPS flagged).
      referenceDecision: [false, true].flatMap((whole) => [false, true].flatMap((counts) => [false, true].flatMap((probing) => [false, true].flatMap((lastAuditorAttempt) => (
        [[], ['flips'], ['kbf', 'flips']].map((confirming) => flipsReferenceDecision({ whole, counts, probing, lastAuditorAttempt, confirming }))))))),
      judged: SAMPLE_FLIPS_CHECKS.map(([name, edit]) => {
        const judged = judgeFlips(sampleFlipsRecord(edit))
        return [name, judged.outcome, judged.p === null ? null : Number(judged.p.toExponential(6)), judged.noSequence?.code ?? null,
          judged.repeats?.code ?? null, judged.profileMismatch?.code ?? null]
      }),
    },
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
  // One token off in every round, the same way twice: a mismatch only under an exact count (tokenizer-precheck-v2).
  [{ referenceDelta: 100, sellerDeltas: [101, 101] }, { referenceDelta: 90, sellerDeltas: [91, 91] }, { referenceDelta: 80, sellerDeltas: [81, 81] }],
  // Two rounds off, then the exact count: a match.
  [{ referenceDelta: 100, sellerDeltas: [101, 101] }, { referenceDelta: 90, sellerDeltas: [91, 91] }, { referenceDelta: 80, sellerDeltas: [80] }],
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
  // One seller off with one on the reference's exact count (tokenizer-precheck-v2: only the exact count backs it).
  [132, 119],
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

/** Mode, the seller's short and long counts (reference 60 and 360), and the reasoning of each reply. */
const SAMPLE_ECHO_JUDGEMENTS: ReadonlyArray<readonly ['plain' | 'visible', number, number, number]> = [
  ['plain', 60, 360, 0], ['plain', 63, 363, 0], ['plain', 60, 460, 0], ['plain', 90, 390, 0], ['visible', 60, 360, 4], ['visible', 60, 460, 4],
]

/** A flagged amount, the other sellers' votes, the seller's own spread. */
const SAMPLE_ECHO_CROWDS: ReadonlyArray<readonly [number, ReadonlyArray<number | null>, number]> = [
  [93, [0, 1, -1, 0], 15], [93, [0, 1], 0], [93, [0, 9, 12, null], 0], [93, [0, 0, 92], 0], [60, [0, 0, 30], 0], [93, [0, 1, -1, 0], 35],
]

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
