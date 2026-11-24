import assert from 'node:assert/strict'
import { writeJsonAtomic } from './atomic-files.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decidedChecks, flaggingChecks, passedChecks, type AuditCheckId } from './audit-checks.js'
import { storedRequestsOf, validateStoredChecks } from './audit-checks.js'
import { VERIFIER_VERDICT } from '@antseed/node/payments'
import { needsExtension } from './close-call.js'
import { adjudicateQuestions, validateAuditMatchesSummary } from './model-audit.js'
import type { ModelVerificationResumeInput, ModelVerificationSkip } from './model-run.js'
import { FLIPS_AUDITOR_FAILURE, FLIPS_WAITING_FOR_REFERENCE, flipsReferenceDecision, type FlipsV1 } from './methods/flips/flips.js'
import { decidedRecords, earliestAuditorTime, readingsOfEvidence, resumeMaterialFor, verdictOf } from './audit-checks.js'
import { modelAuditsDirectory } from './audit-artifacts.js'
import { CONFIRMATION_MIN_DELAY_SECONDS, decide, isFreshConfirmation } from './same-check.js'
import { loadCheckpointResumeCandidates, loadResumeCandidates } from '../cli/commands/verifier/run.js'
import { canonicalHashBytes32 } from '@antseed/fingerprints'
import { emptyAuditCostSummary } from './proxy-evidence.js'
import { FLIPS_RULE } from './methods/flips/flips-score.js'
import { OUTPUT_CAP_RULE, type OutputCapV1 } from './methods/output-cap/output-cap.js'
import { OUTPUT_ECHO_RULE, type OutputEchoV1 } from './methods/output-echo/output-echo.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import { MODEL, MODEL_TOKENIZER, OTHER_TOKENIZER, PEER_ID, SERVICE, audit } from './seller-audit.test-support.js'
import { TOKENIZER_PRECHECK_RULE } from './methods/tokens/tokenizer-precheck.js'

test('a seller skipped at its first question still reports what its pre-check sent and cost', async () => {
  const { skipped, precheckRequests } = await audit({ usage: MODEL_TOKENIZER, refuseQuestions: true })
  assert.equal(skipped!.status, 'SKIPPED')
  assert.equal(precheckRequests.length, 2)
  const skip = skipped as ModelVerificationSkip
  assert.equal(skip.requestCount, 2)
  assert.equal(skip.cost!.pricedExchangeCount, 2)
  assert.ok(skip.cost!.estimatedCostUsd > 0)
  // A pre-check carried from an earlier attempt was paid for there: the skip that carries it reports no cost for it.
  const first = await audit({ usage: MODEL_TOKENIZER })
  const carried = await audit({
    usage: MODEL_TOKENIZER, refuseQuestions: true,
    resume: {
      parentAuditId: first.result.auditId, reservationAuditId: first.result.auditId, parentEvidenceHash: first.result.evidenceHash,
      exchanges: [], records: { tokenizerPrecheck: first.evidence.tokenizerPrecheck! },
    },
  })
  const carriedSkip = carried.skipped as ModelVerificationSkip
  assert.equal(carriedSkip.status, 'SKIPPED')
  assert.equal(carriedSkip.cost?.pricedExchangeCount ?? 0, 0)
  assert.equal(carriedSkip.requestCount ?? 0, 0, 'nor any request of it')
})

test('a resume carries the pre-check its earlier attempt finished; a resume whose parent has none runs it', async () => {
  const first = await audit({ usage: MODEL_TOKENIZER })
  const resume = (exchanges: ProxyAuditEvidenceV1['exchanges'], records = {}): ModelVerificationResumeInput => ({
    parentAuditId: first.result.auditId, reservationAuditId: first.result.auditId, parentEvidenceHash: first.result.evidenceHash, exchanges, records,
  })
  // Each test runs once in an audit's chain of attempts: the carried match stands, and the seller is not asked again.
  const answered = await audit({ usage: OTHER_TOKENIZER, resume: resume(first.evidence.exchanges.slice(0, 1), { tokenizerPrecheck: first.evidence.tokenizerPrecheck }) })
  assert.equal(answered.precheckRequests.length, 0)
  assert.equal(answered.backerRequests.length, 0)
  assert.equal(answered.result.tokenizerPrecheck!.outcome, 'match')
  assert.equal(answered.result.status, 'SAME')
  assert.equal(answered.questionRequests.length, first.questionRequests.length - 1)
  assert.equal(answered.result.requestCount, answered.questionRequests.length + 1, 'the carried pre-check was paid for by its own attempt')

  const unanswered = await audit({ usage: OTHER_TOKENIZER, resume: resume([]) })
  assert.equal(unanswered.result.status, 'DIFF')
  assert.equal(unanswered.precheckRequests.length, 12)
  assert.ok(unanswered.questionRequests.length > 0)
})

test('an extra set of a close call, and an audit without the pre-check, go straight to the questions', async () => {
  let referenceAsked = 0
  const extension = await audit({ usage: OTHER_TOKENIZER, extension: true, onReference: () => { referenceAsked += 1 } })
  assert.equal(extension.result.status, 'SAME')
  assert.equal(extension.precheckRequests.length, 0)
  assert.equal(referenceAsked, 0)
  assert.equal(extension.result.tokenizerPrecheck, undefined)
  assert.equal(extension.evidence.tokenizerPrecheck, undefined)

  const off = await audit({ usage: OTHER_TOKENIZER, precheck: false })
  assert.equal(off.result.status, 'SAME')
  assert.equal(off.precheckRequests.length, 0)
})

test('submission refuses a verdict its tests and questions do not give', async () => {
  const { result, evidence } = await audit({ usage: OTHER_TOKENIZER })
  const edit = (change: (copy: ProxyAuditEvidenceV1) => void): ProxyAuditEvidenceV1 => {
    const copy = structuredClone(evidence)
    change(copy)
    return copy
  }
  const { tokenizerPrecheck: _precheck, ...bare } = result
  // Without the mismatch nothing flagged: the questions' SAME is the verdict, not the stored DIFF.
  assert.throws(() => validateAuditMatchesSummary(edit((copy) => { delete copy.tokenizerPrecheck }), bare), /^Error: verdict mismatch$/)
  assert.throws(() => validateAuditMatchesSummary(edit((copy) => { delete copy.tokenizerPrecheck }), result), /summary's tokenizer pre-check is not the one in its evidence/)
  // The counts the report prints are the evidence's.
  assert.deepEqual(result.tokenizerPrecheck!.sellerTokens, evidence.tokenizerPrecheck!.rounds.map((round) => round.seller[0]!.delta))
  assert.deepEqual(result.tokenizerPrecheck!.modelTokens, evidence.tokenizerPrecheck!.rounds.map((round) => round.reference.delta))
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, tokenizerPrecheck: { ...result.tokenizerPrecheck!, modelTokens: [1, 2, 3] } }), /summary's tokenizer pre-check is not the one in its evidence/)
  assert.throws(() => validateAuditMatchesSummary(edit((copy) => { copy.tokenizerPrecheck!.rounds[0]!.seller[0]!.delta! += 9 }), result), /difference does not follow/)
  // The questions' own verdict is the evidence's, and the audit's is recomputed: neither can be claimed.
  assert.throws(() => validateAuditMatchesSummary(edit((copy) => { copy.result.verdict = 'DIFF' }), result), /the questions' first look says DIFF, but its stored answers give SAME/)
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, status: 'SAME' }), /^Error: verdict mismatch$/)
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, questionsStatus: 'DIFF' }), /questions verdict mismatch/)
  // A file that does not name its format is not read: nothing reads an audit DIFF as a questions DIFF.
  assert.throws(() => validateAuditMatchesSummary(edit((copy) => { delete copy.tests }), result), /does not name the all-tests format/)
})

test('a confirmation of a questions DIFF in which the pre-check flags is a DIFF of the pre-check, its questions\' SAME apart', async () => {
  // The first auditor's questions flagged the seller. Here the pre-check finds a mismatch and the questions pass:
  // any flag is a DIFF, attributed to the pre-check alone, so the same-check rule sends nothing for it.
  const { result, evidence, questionRequests } = await audit({ usage: OTHER_TOKENIZER, confirming: ['kbf'] })
  assert.equal(result.tokenizerPrecheck!.outcome, 'mismatch')
  assert.ok(questionRequests.length > 0)
  assert.equal(result.status, 'DIFF')
  assert.equal(result.questionsStatus, 'SAME', 'the questions decide their own verdict: these answers are the model\'s')
  assert.deepEqual(evidence.confirming, { checks: ['kbf'] })
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
  assert.deepEqual(flaggingChecks(evidence, result.questionsStatus!), ['tokens'])
  assert.deepEqual(passedChecks(evidence, result.questionsStatus!), ['kbf'])
  // The same audit outside a confirmation is the same verdict: no test is special any more.
  const { confirming: _confirming, ...plain } = evidence
  const { confirming: _checks, ...firstLook } = result
  assert.doesNotThrow(() => validateAuditMatchesSummary(plain, firstLook))
  // A confirmation of a pre-check DIFF asks its questions too, and repeats the pre-check's flag.
  const tokens = await audit({ usage: OTHER_TOKENIZER, confirming: ['tokens'] })
  assert.equal(tokens.result.status, 'DIFF')
  assert.ok(tokens.questionRequests.length > 0)
  assert.deepEqual(flaggingChecks(tokens.evidence, tokens.result.questionsStatus!), ['tokens'])
})

test('a confirmation of a pre-check DIFF whose pre-check did not run is an undecided attempt, never a SAME', async () => {
  // The check to repeat did not decide, so the questions' SAME is not this confirmation's answer. It is UNDETERMINED
  // with a reason the epoch plan audits again, and submit sends nothing. Its questions were asked like any audit's.
  const { result, evidence, questionRequests } = await audit({ usage: MODEL_TOKENIZER, precheck: false, confirming: ['tokens'] })
  assert.ok(questionRequests.length > 0)
  assert.equal(result.status, 'UNDETERMINED')
  assert.equal(result.questionsStatus, 'SAME')
  assert.equal(result.outcomeReason?.code, 'confirmation_undecided')
  assert.equal(needsExtension({ ...result, decisionRule: 'kbf-extension-v2' }), false)
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
})

// The check pipeline: the cap and echo checks as stand-in screens, so the order, the verdict over every test, the
// confirmation rule and the seller's clock of `verifyModelTarget` are pinned (the pre-check is real).

const STAND_IN_COST = { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCostUsd: 0.001 }
const standInRequest = (id: string) => ({ requestIds: [id], statusCode: 200, attemptCosts: [STAND_IN_COST], responseAuth: null, failureReason: null })

const capRecord = (outcome: OutputCapV1['outcome']): OutputCapV1 => ({
  rule: OUTPUT_CAP_RULE, outcome, reason: `cap ${outcome}`,
  asks: [{ cap: 20, class: outcome === 'flag' ? 'over' : 'within', reading: { billedOutputTokens: outcome === 'flag' ? 90 : 12 }, measurement: null, request: standInRequest('cap-1') }],
} as never)

const echoRecord = (outcome: OutputEchoV1['outcome'], findings: { flag?: OutputEchoV1['flag']; growth?: OutputEchoV1['outcome']; fixedAmount?: OutputEchoV1['outcome'] } = {}): OutputEchoV1 => ({
  rule: OUTPUT_ECHO_RULE, outcome, flag: findings.flag ?? (outcome === 'flag' ? 'growth' : null), reason: `echo ${outcome}`,
  growth: { outcome: findings.growth ?? outcome, reason: '' },
  fixedAmount: { outcome: findings.fixedAmount ?? 'inconclusive', reason: '' },
  rounds: [{ growths: [1], short: [{ request: standInRequest('echo-s') }], long: [{ request: standInRequest('echo-l') }] }],
  offset: { median: null }, crowd: null,
} as never)

/** Stand-in screens that log every call, return the given records, and can spend the auditor's time. */
function standInScreens(input: { cap?: OutputCapV1 | null; echo?: OutputEchoV1 | null; readyDelayMs?: number; checkDelayMs?: number }) {
  const calls: string[] = []
  const wait = (ms?: number) => (ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve())
  const outputCap = {
    ready: async () => { calls.push('cap.ready'); await wait(input.readyDelayMs); return {} as never },
    check: async () => { calls.push('cap.check'); await wait(input.checkDelayMs); return input.cap ?? null },
  }
  const outputEcho = {
    ready: async () => { calls.push('echo.ready'); await wait(input.readyDelayMs); return {} as never },
    check: async (_seller: unknown, _settings: unknown, options: { precheckMatch: boolean }) => {
      calls.push(`echo.check precheckMatch=${options.precheckMatch}`)
      await wait(input.checkDelayMs)
      return input.echo ?? null
    },
  }
  return { calls, screens: { outputCap, outputEcho } }
}

/** Runs one audit with stand-in cap and echo screens, and the order in which the tests reached the seller. */
async function pipeline(options: Parameters<typeof audit>[0] & { cap?: OutputCapV1 | null; echo?: OutputEchoV1 | null; readyDelayMs?: number; checkDelayMs?: number }) {
  const { calls, screens } = standInScreens(options)
  const ran = await audit({
    ...options,
    ...screens,
    onQuestion: () => { if (!calls.includes('questions')) calls.push('questions') },
  })
  return { ...ran, calls }
}

test('check pipeline: every test runs after any flag, the questions before the cap and echo checks', async () => {
  const { calls, result, evidence, questionRequests } = await pipeline({ usage: MODEL_TOKENIZER, cap: capRecord('flag'), echo: echoRecord('pass') })
  // The references are measured first, on the auditor's time; the questions keep their place before the other tests.
  assert.deepEqual(calls, ['cap.ready', 'echo.ready', 'questions', 'cap.check', 'echo.check precheckMatch=true'])
  assert.ok(questionRequests.length > 0)
  assert.equal(result.status, 'DIFF')
  assert.equal(result.questionsStatus, 'SAME')
  assert.equal(evidence.result.verdict, 'SAME', 'the evidence\'s result is the questions\' own')
  assert.deepEqual(flaggingChecks(evidence, result.questionsStatus!), ['output-cap'])
  assert.deepEqual(passedChecks(evidence, result.questionsStatus!), ['tokens', 'output-echo', 'kbf'])
  // Every request is paid for with the audit: the batches, the pre-check's two, the cap check's one, the echo's two.
  assert.equal(result.requestCount, questionRequests.length + 2 + 1 + 2)
  assert.equal(result.cost.pricedExchangeCount, 5)
})

test('check pipeline: an echo flag is a DIFF beside the questions; the echo check is told the pre-check matched', async () => {
  const { calls, result, evidence } = await pipeline({ usage: MODEL_TOKENIZER, cap: capRecord('pass'), echo: echoRecord('flag') })
  assert.deepEqual(calls, ['cap.ready', 'echo.ready', 'questions', 'cap.check', 'echo.check precheckMatch=true'])
  assert.equal(result.status, 'DIFF')
  assert.deepEqual(flaggingChecks(evidence, result.questionsStatus!), ['output-echo'])
  assert.deepEqual(passedChecks(evidence, result.questionsStatus!), ['tokens', 'output-cap', 'kbf'])
})

test('check pipeline: tests that pass, or have no result, leave the verdict to the questions', async () => {
  const passing = await pipeline({ usage: MODEL_TOKENIZER, cap: capRecord('pass'), echo: echoRecord('pass') })
  assert.equal(passing.result.status, 'SAME')
  assert.deepEqual(passedChecks(passing.evidence, 'SAME'), ['tokens', 'output-cap', 'output-echo', 'kbf'])
  // An undecided test never blocks SAME.
  const undecided = await pipeline({ usage: () => 0, cap: capRecord('inconclusive'), echo: null })
  assert.equal(undecided.result.status, 'SAME')
  assert.deepEqual(undecided.result.tokenizerPrecheck, { rule: TOKENIZER_PRECHECK_RULE.id, outcome: 'inconclusive' })
})

test('check pipeline: a counted fixed amount flags as its own finding', async () => {
  const { result, evidence } = await pipeline({ usage: MODEL_TOKENIZER, echo: echoRecord('flag', { flag: 'offset', growth: 'pass', fixedAmount: 'flag' }) })
  assert.equal(result.status, 'DIFF')
  assert.deepEqual(flaggingChecks(evidence, result.questionsStatus!), ['output-offset'])
})

test('check pipeline: a pre-check mismatch ends nothing: the questions, the cap check and the echo check all run', async () => {
  const { calls, result, evidence } = await pipeline({ usage: OTHER_TOKENIZER, cap: capRecord('flag'), echo: echoRecord('flag') })
  assert.deepEqual(calls, ['cap.ready', 'echo.ready', 'questions', 'cap.check', 'echo.check precheckMatch=false'])
  assert.equal(result.status, 'DIFF')
  assert.deepEqual(flaggingChecks(evidence, result.questionsStatus!), ['tokens', 'output-cap', 'output-echo'])
})

test('check pipeline: a flag stands when the seller is skipped afterwards; with no flag the skip is a skip', async () => {
  const flagged = await pipeline({ usage: OTHER_TOKENIZER, cap: capRecord('pass'), echo: echoRecord('pass'), refuseQuestions: true })
  assert.equal(flagged.result.status, 'DIFF', 'a seller that goes silent after a flag does not erase it')
  assert.equal(flagged.result.questionsStatus, 'UNDETERMINED')
  assert.match(flagged.evidence.result.verdictReason!, /the questions were not finished: the seller was skipped/)
  assert.deepEqual(flagged.calls, ['cap.ready', 'echo.ready', 'questions'], 'nothing more is asked of a skipped seller')
  assert.deepEqual(flaggingChecks(flagged.evidence, 'UNDETERMINED'), ['tokens'])
  const clean = await audit({ usage: MODEL_TOKENIZER, refuseQuestions: true })
  assert.equal(clean.skipped!.status, 'SKIPPED')
})

test('a seller skipped late, after a flag, leaves its questions unfinished: both readers accept the stored UNDETERMINED, and only when the skip is stored', async () => {
  // A retry reuses every answered batch but the first, which is asked again and refused: the seller is skipped there with
  // the others answered (their numbers alone would decide). The pre-check flagged.
  const first = await audit({ usage: OTHER_TOKENIZER })
  const late = await audit({
    usage: OTHER_TOKENIZER, refuseQuestions: true,
    resume: {
      parentAuditId: first.result.auditId, reservationAuditId: first.result.auditId, parentEvidenceHash: first.result.evidenceHash,
      exchanges: first.evidence.exchanges.filter((exchange) => exchange.batchIndex !== 0), records: {},
    },
  })
  assert.equal(late.result.status, 'DIFF', 'the flag stands')
  assert.equal(late.evidence.result.verdict, 'UNDETERMINED')
  assert.ok(late.evidence.result.unfinished, 'the evidence names where the questions stopped')
  assert.ok(late.evidence.result.parsedProbeCount * 2 >= late.evidence.reference.probes.length, 'enough answers that the numbers alone would decide')
  // Submit's validator and the confirmer's adjudicator both accept it.
  assert.doesNotThrow(() => validateAuditMatchesSummary(late.evidence, late.result))
  assert.equal(adjudicateQuestions({ evidence: late.evidence, extraSets: [], decisionRule: late.result.decisionRule, closed: false }).verdict, 'UNDETERMINED')
  // A mark the evidence cannot back is ignored by both readers: the numbers decide, and the stored label is refused.
  const skipped = late.evidence.exchanges.find((exchange) => exchange.batchIndex === late.evidence.result.unfinished!.batchIndex)!
  assert.equal(skipped.status, 'failed')
  assert.equal(late.evidence.result.unfinished!.reason, skipped.outcomeReason!.summary, 'the mark carries the failure the run stored')
  const succeeded = late.evidence.exchanges.find((exchange) => exchange.status === 'succeeded')!
  const withMark = (unfinished: { batchIndex: number; reason: string }, exchanges = late.evidence.exchanges) => ({
    ...late.evidence, exchanges, result: { ...late.evidence.result, unfinished },
  })
  const unbacked = [
    // It names a batch that succeeded.
    withMark({ ...late.evidence.result.unfinished!, batchIndex: succeeded.batchIndex }),
    // Its reason is not the stored failure's.
    withMark({ ...late.evidence.result.unfinished!, reason: 'some other reason' }),
    // The batch it names is labelled failed but kept scored answers.
    withMark(late.evidence.result.unfinished!, late.evidence.exchanges.map((exchange) => (
      exchange === skipped ? { ...exchange, matches: exchange.matches.map(() => 1 as const) } : exchange
    ))),
  ]
  for (const evidence of unbacked) {
    assert.throws(() => adjudicateQuestions({ evidence, extraSets: [], decisionRule: late.result.decisionRule, closed: false }), /first look says UNDETERMINED, but its stored answers give/)
    assert.throws(() => validateAuditMatchesSummary(evidence, late.result))
  }
})

test('check pipeline: an extra set of a close call asks questions only', async () => {
  const { calls, result, evidence, questionRequests } = await pipeline({ usage: OTHER_TOKENIZER, extension: true, cap: capRecord('flag'), echo: echoRecord('flag') })
  assert.deepEqual(calls, ['questions'])
  assert.ok(questionRequests.length > 0)
  assert.equal(evidence.tokenizerPrecheck, undefined)
  assert.equal(result.status, 'SAME')
})

test('check pipeline: a confirmation of the questions\' DIFF runs every test; the flags of others make it a DIFF of theirs', async () => {
  const { calls, result, evidence } = await pipeline({ usage: MODEL_TOKENIZER, confirming: ['kbf'], cap: capRecord('flag'), echo: echoRecord('flag') })
  assert.deepEqual(calls, ['cap.ready', 'echo.ready', 'questions', 'cap.check', 'echo.check precheckMatch=true'])
  assert.equal(result.status, 'DIFF')
  assert.equal(result.questionsStatus, 'SAME')
  assert.deepEqual(flaggingChecks(evidence, result.questionsStatus!), ['output-cap', 'output-echo'])
})

test('check pipeline: a confirmation of a cap DIFF whose cap check did not decide is an undecided attempt, whatever else flagged', async () => {
  const { result, questionRequests } = await pipeline({ usage: MODEL_TOKENIZER, confirming: ['output-cap'], cap: capRecord('inconclusive'), echo: echoRecord('flag') })
  assert.ok(questionRequests.length > 0)
  assert.equal(result.status, 'UNDETERMINED')
  assert.equal(result.outcomeReason?.code, 'confirmation_undecided')
  assert.equal(result.questionsStatus, 'SAME')
})

test('check pipeline: a confirmation of a cap DIFF repeats its flag', async () => {
  const { calls, result } = await pipeline({ usage: MODEL_TOKENIZER, confirming: ['output-cap'], cap: capRecord('flag'), echo: echoRecord('pass') })
  assert.deepEqual(calls, ['cap.ready', 'echo.ready', 'questions', 'cap.check', 'echo.check precheckMatch=true'])
  assert.equal(result.status, 'DIFF')
})

test('check pipeline: the cap and echo references and checks are the auditor\'s time, not the seller\'s', async () => {
  // Both references and both checks take longer than the seller's idle limit without a request to it being out.
  const { result, questionRequests } = await pipeline({ usage: MODEL_TOKENIZER, auditTimeoutMs: 100, cap: capRecord('pass'), echo: echoRecord('pass'), readyDelayMs: 150, checkDelayMs: 150 })
  assert.equal(result.status, 'SAME')
  assert.equal(result.outcomeReason, null)
  assert.ok(questionRequests.length > 0)
})

test('check pipeline: questions that end in a seller failure start no other test, so a retry asks them', async () => {
  const { calls, result, evidence } = await pipeline({ usage: MODEL_TOKENIZER, failQuestions: true, cap: capRecord('pass'), echo: echoRecord('pass') })
  assert.deepEqual(calls, ['cap.ready', 'echo.ready', 'questions'])
  assert.equal(result.status, 'UNDETERMINED')
  assert.equal(evidence.outputCap, undefined)
  assert.equal(evidence.outputEcho, undefined)
  // The questions' finding is decided from the evidence: a questions DIFF with nothing scored is refused at submit.
  const zero = structuredClone(evidence)
  zero.result.verdict = 'DIFF'
  assert.throws(() => validateAuditMatchesSummary(zero, { ...result, status: 'DIFF', questionsStatus: 'DIFF' }), /the questions' first look says DIFF, but its stored answers give UNDETERMINED/)
  // A close call can be closed only when its look was one.
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, decisionRule: 'kbf-extension-v2', closeCallClosed: { reason: 'x' } }), /latest look was not a close call/)
})

test('check pipeline: FLIPS runs last, on the confirmation stage only for a FLIPS flag; a counted flag is a DIFF, a scored one is carried', async () => {
  const stages: string[] = []
  const flipsRecord = (outcome: FlipsV1['outcome'], counted: boolean, p: number | null): FlipsV1 => ({
    rule: 'flips-v1', draw: { auditor: '0x00', model: MODEL, epoch: '1', seed: '00', stage: 'first' }, service: SERVICE,
    referenceUpstream: null, referenceOneProvider: true, pairs: [], reasks: 0, outcome, counted, score: p === null ? null : 3, scoreMax: null, p, reason: outcome,
  })
  const screen = (record: FlipsV1) => ({ check: async (_seller: unknown, _settings: unknown, options: { stage: string }) => { stages.push(`flips.check stage=${options.stage}`); return record } })
  const flagged = await pipeline({ usage: MODEL_TOKENIZER, cap: capRecord('pass'), echo: echoRecord('pass'), flips: screen(flipsRecord('flag', true, 0.001)) })
  assert.deepEqual([...flagged.calls, ...stages], ['cap.ready', 'echo.ready', 'questions', 'cap.check', 'echo.check precheckMatch=true', 'flips.check stage=first'])
  assert.equal(flagged.result.flips!.outcome, 'flag')
  // Whether FLIPS counts is the rule's, never the stored flag's: recorded only as shipped, the verdict is the questions'.
  assert.equal(flagged.result.status, 'SAME')
  assert.deepEqual(flaggingChecks(flagged.evidence, flagged.result.questionsStatus!), [])
  // Under a rule that counts FLIPS for this model, the same record is a DIFF of FLIPS.
  const counting = { flips: { ...FLIPS_RULE, counts: { default: true, never: ['minimax-m3'] } } }
  const readings = readingsOfEvidence({ ...flagged.evidence, flips: { ...flagged.evidence.flips!, draw: { ...flagged.evidence.flips!.draw, model: 'claude-opus-5.5' } } }, 'SAME', counting)
  assert.deepEqual(verdictOf(readings, 'SAME').flaggedBy, ['flips'])
  // A confirmation of a FLIPS flag is the confirmation stage; a confirmation of another test is a first look for FLIPS.
  stages.length = 0
  await pipeline({ usage: MODEL_TOKENIZER, confirming: ['flips'], flips: screen(flipsRecord('pass', true, 0.4)) })
  await pipeline({ usage: MODEL_TOKENIZER, confirming: ['kbf'], flips: screen(flipsRecord('pass', true, 0.4)) })
  assert.deepEqual(stages, ['flips.check stage=confirm', 'flips.check stage=first'])
  // A retry keeps a scored FLIPS whatever its outcome, so it is never drawn twice; a FLIPS with no score is asked again.
  assert.ok(decidedRecords({ flips: flipsRecord('inconclusive', true, 0.02) }).flips)
  assert.equal(decidedRecords({ flips: flipsRecord('inconclusive', true, null) }).flips, undefined)
})

test('check pipeline: a diagnostic FLIPS stops nothing: a failed checkpoint write made only for it, and a requested probe asks again over a carried record', async () => {
  const flipsRecord = (probe: boolean): FlipsV1 => ({
    rule: 'flips-v1', draw: { auditor: '0x00', model: MODEL, epoch: '1', seed: '00', stage: 'first', ...(probe ? { probe: true as const } : {}) }, service: SERVICE,
    referenceUpstream: null, referenceOneProvider: true, pairs: [], reasks: 0, outcome: 'pass', counted: false, score: 1, scoreMax: null, p: 0.4, reason: 'pass',
  })
  // Every checkpoint write before FLIPS succeeds; the one made for FLIPS fails: the audit still finishes.
  let flipsDone = false
  const writeCheckpoint = async (path: string, value: unknown) => {
    if (flipsDone) throw new Error('disk full')
    await writeJsonAtomic(path, value)
  }
  const failing = await pipeline({
    usage: MODEL_TOKENIZER, cap: capRecord('pass'), echo: echoRecord('pass'), writeCheckpoint,
    flips: { check: async () => { flipsDone = true; return flipsRecord(false) } },
  })
  assert.equal(failing.result.status, 'SAME')
  assert.equal(failing.result.flips?.outcome, 'pass')
  // A carried record that is not a probe's is asked again when a probe is on; a probe's is carried.
  const asked: string[] = []
  const first = await audit({ usage: MODEL_TOKENIZER })
  const resume = (flips: FlipsV1) => ({
    parentAuditId: first.result.auditId, reservationAuditId: first.result.auditId, parentEvidenceHash: first.result.evidenceHash,
    exchanges: first.evidence.exchanges, records: { tokenizerPrecheck: first.evidence.tokenizerPrecheck!, flips },
  })
  const probing = { probing: true, probeSettings: 'A', warm: () => undefined, check: async () => { asked.push('flips'); return { ...flipsRecord(true), probeSettings: 'A' } } }
  const reasked = await audit({ usage: MODEL_TOKENIZER, flips: probing, resume: resume(flipsRecord(false)) })
  assert.deepEqual(asked, ['flips'])
  assert.equal(reasked.evidence.flips?.draw.probe, true)
  await audit({ usage: MODEL_TOKENIZER, flips: probing, resume: resume({ ...flipsRecord(true), probeSettings: 'A' }) })
  assert.deepEqual(asked, ['flips'], 'a probe\'s record of the same settings is carried')
  await audit({ usage: MODEL_TOKENIZER, flips: probing, resume: resume({ ...flipsRecord(true), probeSettings: 'B' }) })
  assert.deepEqual(asked, ['flips', 'flips'], 'a probe of other settings is asked again')
  // A carried record without its shape is dropped and asked again, never read.
  const damaged = await audit({ usage: MODEL_TOKENIZER, flips: probing, resume: resume({ rule: 'flips-v1' } as never) })
  assert.deepEqual(asked, ['flips', 'flips', 'flips'])
  assert.equal(damaged.evidence.flips?.draw.probe, true)
})

test('check pipeline: a carried FLIPS of another rule is asked again; a FLIPS reference that is not whole leaves FLIPS out and the audit runs', async () => {
  const flipsRecord = (rule: string): FlipsV1 => ({
    rule, draw: { auditor: '0x00', model: MODEL, epoch: '1', seed: '00', stage: 'first' }, service: SERVICE,
    referenceUpstream: null, referenceOneProvider: true, pairs: [], reasks: 0, outcome: 'pass', counted: false, score: 1, scoreMax: null, p: 0.4, reason: 'pass',
  })
  const asked: string[] = []
  const screen = { ruleId: 'flips-v1', check: async () => { asked.push('flips'); return flipsRecord('flips-v1') } }
  const first = await audit({ usage: MODEL_TOKENIZER })
  const resume = (flips: FlipsV1) => ({
    parentAuditId: first.result.auditId, reservationAuditId: first.result.auditId, parentEvidenceHash: first.result.evidenceHash,
    exchanges: first.evidence.exchanges, records: { tokenizerPrecheck: first.evidence.tokenizerPrecheck!, flips },
  })
  // A record judged under another rule than this build's is asked again under this build's rule.
  const again = await audit({ usage: MODEL_TOKENIZER, flips: screen, resume: resume(flipsRecord('flips-v0')) })
  assert.deepEqual(asked, ['flips'])
  assert.equal(again.evidence.flips?.rule, 'flips-v1')
  // A record of this build's rule is carried.
  await audit({ usage: MODEL_TOKENIZER, flips: screen, resume: resume(flipsRecord('flips-v1')) })
  assert.deepEqual(asked, ['flips'])

  // The FLIPS reference of this stage is not whole this run, where FLIPS counts: FLIPS is not active for the model, and
  // the audit runs with the questions and the other tests, on any attempt. It never holds the model back.
  let questions = 0
  const failed = {
    ruleId: 'flips-v1',
    referenceDecision: async (_stage: unknown, _service: unknown, _settings: unknown, attempt: { confirming: readonly string[] }) => (
      flipsReferenceDecision({ whole: false, counts: true, probing: false, ...attempt })),
    check: async () => { asked.push('failed'); return null },
  }
  const firstLook = await audit({ usage: MODEL_TOKENIZER, flips: failed, onQuestion: () => { questions += 1 } })
  assert.ok(questions > 0, 'the questions are asked')
  assert.equal(firstLook.result.status, 'SAME')
  assert.equal(firstLook.evidence.flips, undefined)
  const last = await audit({ usage: MODEL_TOKENIZER, flips: failed, lastAuditorAttempt: true })
  assert.equal(last.result.status, 'SAME')
  assert.equal(last.evidence.flips, undefined)
  // Only a confirmation of a report only FLIPS flagged is not started: without FLIPS it could decide nothing, and nothing
  // is paid for it.
  questions = 0
  await assert.rejects(audit({ usage: MODEL_TOKENIZER, flips: failed, confirming: ['flips'], confirmingReportedAt: 1, onQuestion: () => { questions += 1 } }),
    (error: Error) => error.message === `${FLIPS_AUDITOR_FAILURE}: ${FLIPS_WAITING_FOR_REFERENCE}`)
  assert.equal(questions, 0)
  // One that also repeats the questions runs: the questions can still confirm the report.
  const both = await audit({ usage: MODEL_TOKENIZER, flips: failed, confirming: ['kbf', 'flips'], confirmingReportedAt: 1 })
  assert.equal(both.evidence.flips, undefined)
})

test('check pipeline: a carried FLIPS is kept only for its own stage', async () => {
  const flipsRecord = (stage: 'first' | 'confirm'): FlipsV1 => ({
    rule: 'flips-v1', draw: { auditor: '0x00', model: MODEL, epoch: '1', seed: '00', stage }, service: SERVICE,
    referenceUpstream: null, referenceOneProvider: true, pairs: [], reasks: 0, outcome: 'pass', counted: false, score: 1, scoreMax: null, p: 0.4, reason: 'pass',
  })
  const asked: string[] = []
  const screen = { check: async (_seller: unknown, _settings: unknown, options: { stage: 'first' | 'confirm' }) => { asked.push(options.stage); return flipsRecord(options.stage) } }
  const first = await audit({ usage: MODEL_TOKENIZER })
  const resume = (flips: FlipsV1) => ({
    parentAuditId: first.result.auditId, reservationAuditId: first.result.auditId, parentEvidenceHash: first.result.evidenceHash,
    exchanges: first.evidence.exchanges, records: { tokenizerPrecheck: first.evidence.tokenizerPrecheck!, flips },
  })
  // A first look's FLIPS never stands for a confirmation of FLIPS: it is drawn again on the confirmation stage.
  const confirmed = await audit({ usage: MODEL_TOKENIZER, confirming: ['flips'], flips: screen, resume: resume(flipsRecord('first')) })
  assert.deepEqual(asked, ['confirm'])
  assert.equal(confirmed.evidence.flips?.draw.stage, 'confirm')
  // Its own stage is carried.
  await audit({ usage: MODEL_TOKENIZER, confirming: ['flips'], flips: screen, resume: resume(flipsRecord('confirm')) })
  assert.deepEqual(asked, ['confirm'])
  // Without a screen too, another stage's record is not kept.
  const unscreened = await audit({ usage: MODEL_TOKENIZER, confirming: ['flips'], resume: resume(flipsRecord('first')) })
  assert.equal(unscreened.evidence.flips, undefined)
})

test('a confirmation resumed from a real checkpoint or retry file reuses only batches of the same report from its cutoff on, and passes submit', async () => {
  const reportedAt = Math.floor(Date.now() / 1_000) - 7_200
  const cutoff = reportedAt + CONFIRMATION_MIN_DELAY_SECONDS
  // The waiting DIFF was flagged by the token count, and this seller's count is not the model's: the confirmation flags.
  const identity = { checks: ['tokens'] as AuditCheckId[], reportedAt }
  let checkpoint: Record<string, unknown> | null = null
  const first = await audit({
    usage: OTHER_TOKENIZER, confirming: ['tokens'], confirmingReportedAt: reportedAt,
    writeCheckpoint: async (_path, value) => { checkpoint = structuredClone(value) as Record<string, unknown> },
  })
  assert.ok(first.evidence.exchanges.length >= 4)
  assert.deepEqual(first.evidence.confirming, identity)
  // In milliseconds, as the audit writes them: a batch a second before the cutoff, one exactly at it, one with no send
  // time; the rest after it.
  const timed = (exchanges: ProxyAuditEvidenceV1['exchanges']) => exchanges.map((exchange, index) => (
    index === 0 ? { ...exchange, timing: { ...exchange.timing, startedAt: (cutoff - 1) * 1_000 } }
      : index === 1 ? { ...exchange, timing: { ...exchange.timing, startedAt: cutoff * 1_000 } }
        : index === 2 ? (({ timing: _timing, ...rest }) => rest)(exchange) as typeof exchange
          : exchange
  ))
  const directory = await mkdtemp(join(tmpdir(), 'antseed-confirmation-resume-'))
  try {
    // The checkpoint, in its own place, read by the loader a run uses.
    const stored = { ...checkpoint!, runId: 'run-1', epoch: '7', model: MODEL, exchanges: timed(first.evidence.exchanges) }
    const checkpoints = join(modelAuditsDirectory(directory, '7', MODEL, 'run-1'), '.checkpoints')
    await mkdir(checkpoints, { recursive: true })
    await writeFile(join(checkpoints, 'audit.json'), JSON.stringify(stored))
    const fromCheckpoint = [...(await loadCheckpointResumeCandidates(directory, 'run-1', '7', [MODEL])).values()][0]!
    assert.deepEqual(fromCheckpoint.confirming, identity, 'the checkpoint keeps the report it confirms')
    // A damaged FLIPS in the file (a number canonical JSON cannot hold) is dropped; the resume itself goes on.
    const damaged = JSON.stringify({ ...stored, records: { ...((stored as Record<string, unknown>)['records'] as object), flips: { rule: 'flips-v1', score: 'HUGE' } } }).replace('"HUGE"', '1e400')
    await writeFile(join(checkpoints, 'audit.json'), damaged)
    const kept = [...(await loadCheckpointResumeCandidates(directory, 'run-1', '7', [MODEL])).values()][0]
    assert.ok(kept, 'the checkpoint is still resumed')
    assert.equal(kept!.records?.flips, undefined)
    await writeFile(join(checkpoints, 'audit.json'), JSON.stringify(stored))
    // The retry file: the seller evidence and the summary row that points at it, read by the retry loader.
    const evidence = { ...first.evidence, exchanges: timed(first.evidence.exchanges) }
    const evidencePath = join(directory, 'seller.json')
    await writeFile(evidencePath, JSON.stringify(evidence))
    const summaryPath = join(directory, 'summary.json')
    const summary = {
      version: 1, kind: 'antseed-verifier-model-summary', runId: 'run-1', epoch: '7', model: MODEL, startedAt: '2026-11-19T00:00:00.000Z', completedAt: '2026-11-19T00:00:00.000Z',
      // A retry row is undecided by the shared decision: no flag in its summary, its questions undecided.
      results: [{ ...first.result, tokenizerPrecheck: undefined, status: 'UNDETERMINED', questionsStatus: 'UNDETERMINED', evidencePath, evidenceHash: canonicalHashBytes32(evidence) }], failures: [], skipped: [], cost: emptyAuditCostSummary(),
    }
    await writeFile(summaryPath, JSON.stringify(summary))
    const manifest = {
      version: 1, kind: 'antseed-verifier-run-manifest', runId: 'run-1', state: 'completed', epoch: '7', epochSource: 'utc-day',
      epochStartedAt: '2026-11-19T00:00:00.000Z', epochEndsAt: '2026-11-20T00:00:00.000Z', startedAt: summary.startedAt, completedAt: summary.completedAt,
      summaryPath: join(directory, 'epoch.json'), modelOrder: [MODEL],
      models: [{ model: MODEL, summaryPath, resultCount: 1, failureCount: 0, skippedCount: 0, cost: emptyAuditCostSummary() }], failureCount: 0,
    }
    const fromRetry = [...(await loadResumeCandidates(manifest as never, [MODEL])).values()][0]!
    assert.deepEqual(fromRetry.confirming, identity, 'the retry file keeps the report it confirms')
    const fresh = (at: number | null) => isFreshConfirmation(at, reportedAt)
    for (const candidate of [fromCheckpoint, fromRetry]) {
      const material = resumeMaterialFor(candidate, identity, fresh)
      const kept = material.exchanges.map((exchange) => exchange.batchIndex)
      const all = first.evidence.exchanges.map((exchange) => exchange.batchIndex)
      // Before the cutoff and without a time: asked again. Exactly at the cutoff and after: reused.
      assert.deepEqual(kept, all.filter((index) => index !== all[0] && index !== all[2]))
      const resumed = await audit({
        usage: OTHER_TOKENIZER, confirming: ['tokens'], confirmingReportedAt: reportedAt,
        resume: { parentAuditId: candidate.auditId, reservationAuditId: candidate.reservationAuditId, parentEvidenceHash: candidate.evidenceHash, exchanges: material.exchanges, records: material.records },
      })
      assert.equal(resumed.questionRequests.length, 2, 'the two batches not reused are asked again')
      // What submit checks: the confirmation's earliest request is fresh for its report, and the evidence is the summary's.
      assert.equal(resumed.result.firstRequestAt, earliestAuditorTime([resumed.evidence]))
      assert.ok(isFreshConfirmation(resumed.result.firstRequestAt, reportedAt))
      assert.doesNotThrow(() => validateAuditMatchesSummary(resumed.evidence, resumed.result as never))
      // And submit's own decision on it, with the flags recomputed from the resumed evidence: the same test flagged
      // again, fresh, for the report the evidence names, so its DIFF is sent.
      assert.equal(resumed.result.status, 'DIFF')
      const flaggedBy = flaggingChecks(resumed.evidence, resumed.result.questionsStatus!)
      assert.ok(flaggedBy.includes('tokens'))
      const decision = decide({
        agentId: 1n, serviceHash: '0x00', verdict: VERIFIER_VERDICT.DIFF, auditedAt: earliestAuditorTime([resumed.evidence])!,
        flaggedBy, passedBy: passedChecks(resumed.evidence, resumed.result.questionsStatus!), confirming: resumed.evidence.confirming!,
      }, [{ auditor: '0x00', peerId: 'aa'.repeat(20), evidenceUri: 'ipfs://x', evidenceHash: '0x00', reportedAt, checks: ['tokens'] }])
      assert.equal(decision.kind, 'send')
      // Outside a confirmation nothing is filtered; --resume-run, with no live report, uses the candidate's own.
      assert.equal(resumeMaterialFor(candidate, null, fresh).exchanges.length, all.length)
      assert.deepEqual(resumeMaterialFor(candidate, candidate.confirming!, fresh).exchanges.map((exchange) => exchange.batchIndex), kept)
      // Material of another report, or of a report with no known time, is never reused.
      assert.deepEqual(resumeMaterialFor(candidate, { ...identity, reportedAt: reportedAt + 1 }, fresh), { exchanges: [], records: {} })
      assert.deepEqual(resumeMaterialFor(candidate, { checks: identity.checks }, () => true), { exchanges: [], records: {} })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a retry with every batch answered asks its tests with the seller\'s own thinking setting', async () => {
  const first = await audit({ usage: MODEL_TOKENIZER })
  const thinking: unknown[] = []
  const outputCap = {
    ready: async () => ({}) as never,
    check: async (_seller: unknown, _settings: unknown, setting: unknown) => { thinking.push(setting); return capRecord('pass') },
  }
  const key = `${PEER_ID.replace(/^0x/i, '').toLowerCase()}\u0000${SERVICE}`
  const discovered = { method: 'kbf-reference-code-2026-09-30', strategy: 'enable-thinking-false', maxTokens: 800, attempts: [] }
  const retried = await audit({
    usage: MODEL_TOKENIZER, outputCap, sellerThinking: new Map([[key, Promise.resolve(discovered)]]),
    resume: {
      parentAuditId: first.result.auditId, reservationAuditId: first.result.auditId, parentEvidenceHash: first.result.evidenceHash,
      exchanges: first.evidence.exchanges, records: { tokenizerPrecheck: first.evidence.tokenizerPrecheck! },
    },
  })
  assert.equal(retried.questionRequests.length, 0, 'every batch was answered')
  assert.equal(thinking.length, 1)
  assert.equal((thinking[0] as { strategy?: string } | null)?.strategy, 'enable-thinking-false', 'not the default setting')
})

test('check pipeline: the time is checked before each test: time running out in the cap check starts no echo check', async () => {
  const calls: string[] = []
  const outputCap = {
    ready: async () => ({}) as never,
    check: async (_seller: unknown, _settings: unknown, _thinking: unknown, clock: { start: () => AbortSignal; finish: (answered: boolean) => void }) => {
      calls.push('cap.check')
      clock.start()
      await new Promise((resolve) => setTimeout(resolve, 250))
      clock.finish(false)
      return capRecord('inconclusive')
    },
  } as never
  const outputEcho = { ready: async () => ({}) as never, check: async () => { calls.push('echo.check'); return echoRecord('pass') } }
  const { result } = await audit({ usage: MODEL_TOKENIZER, auditTimeoutMs: 100, outputCap, outputEcho })
  assert.deepEqual(calls, ['cap.check'])
  assert.equal(result.outputEcho, undefined)
})

test('a saved seller file that stores a check slot as null reads as having no such record, for every reader', async () => {
  // Another auditor's software may write `"outputCap": null`; the readers before the list of checks took it as absent.
  const { result, evidence } = await audit({ usage: MODEL_TOKENIZER })
  const saved = JSON.parse(JSON.stringify({ ...evidence, outputCap: null, outputEcho: null })) as ProxyAuditEvidenceV1
  assert.equal(saved.outputCap, null)
  assert.deepEqual(flaggingChecks(saved, 'SAME'), flaggingChecks(evidence, 'SAME'))
  assert.deepEqual(passedChecks(saved, 'SAME'), ['tokens', 'kbf'])
  assert.doesNotThrow(() => validateStoredChecks(saved, 'confirmer'))
  assert.doesNotThrow(() => validateAuditMatchesSummary(saved, result))
  const summary = { ...result, outputCap: null, outputEcho: null } as never
  assert.deepEqual(decidedChecks(summary), ['tokens', 'kbf'])
  assert.doesNotThrow(() => validateAuditMatchesSummary(saved, summary))
  assert.deepEqual(storedRequestsOf(saved).length, storedRequestsOf(evidence).length)
})
