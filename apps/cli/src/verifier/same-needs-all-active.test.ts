import assert from 'node:assert/strict'
import test from 'node:test'
import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { VERIFIER_VERDICT } from '@antseed/node/payments'
import { auditVerdictReason, inactiveChecks, readingsOfEvidence, verdictOf, type ActiveTestsInput, type AuditCheckId } from './audit-checks.js'
import { FLIPS_RULE } from './methods/flips/flips-score.js'
import { OUTPUT_CAP_RULE, type OutputCapScreen, type OutputCapV1 } from './methods/output-cap/output-cap.js'
import { OUTPUT_ECHO_RULE, type OutputEchoV1 } from './methods/output-echo/output-echo.js'
import { TOKENIZER_PRECHECK_RULE, type TokenizerPrecheckV1 } from './methods/tokens/tokenizer-precheck.js'
import { validateAuditMatchesSummary } from './model-audit.js'
import { decide } from './same-check.js'
import { MODEL_TOKENIZER, OTHER_TOKENIZER, audit } from './seller-audit.test-support.js'

/**
 * Rule `same-needs-all-active` (Alex, 23 November): a seller is SAME only when the questions say SAME and every other
 * active test passed. A test is active when its rule counts it for the model and its reference gave it something to
 * judge on. A flag is a DIFF as before; anything else is UNDETERMINED, naming the test.
 */

/** Stand-in records with only what the readings and the active gates read. */
const precheck = (outcome: TokenizerPrecheckV1['outcome'], referenceDeltas: Array<number | null>, reason: string | null = null): TokenizerPrecheckV1 => ({
  rule: TOKENIZER_PRECHECK_RULE, outcome, reason, referenceUpstream: null,
  rounds: referenceDeltas.map((delta) => ({ reference: { asks: [], delta, failure: delta === null ? 'the reference gave no difference' : null }, seller: [] })),
} as never)
const cap = (outcome: OutputCapV1['outcome'], reason = `cap ${outcome}`): OutputCapV1 => ({ rule: OUTPUT_CAP_RULE, outcome, reason, asks: [] } as never)
const echo = (mode: 'plain' | 'visible', growth: OutputEchoV1['outcome'], fixedAmount: OutputEchoV1['outcome'], reasons: { growth?: string; fixedAmount?: string } = {}): OutputEchoV1 => ({
  rule: OUTPUT_ECHO_RULE, mode, flag: growth === 'flag' ? 'growth' : fixedAmount === 'flag' ? 'offset' : null,
  outcome: growth === 'flag' || fixedAmount === 'flag' ? 'flag' : growth === 'pass' && (fixedAmount === 'pass' || mode === 'visible') ? 'pass' : 'inconclusive',
  growth: { outcome: growth, reason: reasons.growth ?? `growth ${growth}` }, fixedAmount: { outcome: fixedAmount, reason: reasons.fixedAmount ?? `fixed ${fixedAmount}` },
  reason: 'echo', rounds: [], crowd: null,
} as never)
const ALL_ROUNDS = Array.from({ length: TOKENIZER_PRECHECK_RULE.rounds }, (_, index) => 100 + index)
const evidenceOf = (records: Record<string, unknown>, extra: { model?: string; noRecord?: Array<{ slot: string; reason: string }> } = {}) => ({
  ...records,
  reference: { referenceModel: extra.model ?? 'example-model' },
  ...(extra.noRecord ? { noRecord: extra.noRecord } : {}),
  exchanges: [{}],
}) as ActiveTestsInput & { exchanges: unknown[] }
const FLIPS_COUNTING = { ...FLIPS_RULE, counts: { default: true } }

test('a SAME needs every active test passed: one active test with no result makes it UNDETERMINED, naming it', () => {
  const passed = evidenceOf({ tokenizerPrecheck: precheck('match', ALL_ROUNDS), outputCap: cap('pass'), outputEcho: echo('plain', 'pass', 'pass') })
  // FLIPS has no record and is recorded only by its rule: not active, so it blocks nothing.
  assert.deepEqual(inactiveChecks(passed).map((entry) => [entry.check, entry.cause]), [['flips', 'rule']])
  assert.equal(verdictOf(readingsOfEvidence(passed, 'SAME'), 'SAME').verdict, 'SAME')
  const open = evidenceOf({
    tokenizerPrecheck: precheck('match', ALL_ROUNDS), outputCap: cap('pass'),
    outputEcho: echo('plain', 'inconclusive', 'pass', { growth: 'a round was under' }),
  })
  const verdict = verdictOf(readingsOfEvidence(open, 'SAME'), 'SAME')
  assert.equal(verdict.verdict, 'UNDETERMINED')
  assert.deepEqual(verdict.openTests, ['output-echo'])
  assert.equal(auditVerdictReason(open, verdict, 'the questions match'),
    'the questions say SAME, but a SAME needs every active test passed: the echo check ran and did not decide: a round was under')
  // The questions' own UNDETERMINED stays theirs, with their reason.
  assert.equal(verdictOf(readingsOfEvidence(open, 'UNDETERMINED'), 'UNDETERMINED').openTests, undefined)
})

test('a test that is not active never blocks SAME: switched off by its reference, not judged for the model, or recorded only', () => {
  const capOff = 'the reference\'s own answer could not be measured, so the cap check does not apply to the model this run'
  const evidence = evidenceOf({
    // The pre-check without a reference difference for a round: the seller is asked nothing, for every seller alike.
    tokenizerPrecheck: precheck('inconclusive', [ALL_ROUNDS[0]!, null, ...ALL_ROUNDS.slice(2)], 'no reference to compare with: the reference gave no difference'),
    // Measured on the visible answer: the fixed amount is not judged.
    outputEcho: echo('visible', 'pass', 'inconclusive', { fixedAmount: 'not judged in visible mode' }),
  }, { model: 'gpt-6.2-sol', noRecord: [{ slot: 'outputCap', reason: capOff }] })
  // Read under a FLIPS rule that counts: it still never counts for GPT-6.2 Sol, which the eval never measured.
  const inactive = inactiveChecks(evidence, { flips: FLIPS_COUNTING })
  assert.deepEqual(inactive, [
    { check: 'tokens', cause: 'run', reason: 'no reference to compare with: the reference gave no difference' },
    { check: 'output-cap', cause: 'run', reason: capOff },
    { check: 'output-offset', cause: 'rule', reason: 'the fixed amount is not judged for a model whose reference shows its reasoning: its echoes are counted on the visible answer' },
    { check: 'flips', cause: 'rule', reason: 'the randomness check is recorded only: its rule does not count it for this model' },
  ])
  assert.equal(verdictOf(readingsOfEvidence(evidence, 'SAME', { flips: FLIPS_COUNTING }), 'SAME').verdict, 'SAME')
  // On a model the counting rule measures, FLIPS is active; it is flag-only, so no FLIPS for the seller blocks nothing.
  const measured = { ...evidence, reference: { referenceModel: 'claude-opus-5.5' } }
  assert.equal(inactiveChecks(measured, { flips: FLIPS_COUNTING }).some((entry) => entry.check === 'flips'), false)
  const counted = verdictOf(readingsOfEvidence(measured, 'SAME', { flips: FLIPS_COUNTING }), 'SAME')
  assert.deepEqual([counted.verdict, counted.openTests], ['SAME', undefined])
  // A pre-check whose reference measured every round is active: its seller-side no result blocks the SAME.
  const sellerSide = evidenceOf({ tokenizerPrecheck: precheck('inconclusive', ALL_ROUNDS, 'the seller signed different counts for the same text') },
    { noRecord: [{ slot: 'outputCap', reason: capOff }, { slot: 'outputEcho', reason: 'the reference did not echo cleanly' }] })
  const blocked = verdictOf(readingsOfEvidence(sellerSide, 'SAME'), 'SAME')
  assert.deepEqual([blocked.verdict, blocked.openTests], ['UNDETERMINED', ['tokens']])
  assert.match(auditVerdictReason(sellerSide, blocked, null)!, /the token-count pre-check ran and did not decide: the seller signed different counts for the same text$/)
})

/** Stand-in cap screens: the reference applied, and the seller's check gives `record` (null: nothing for this seller). */
const capScreen = (record: OutputCapV1 | null): Pick<OutputCapScreen<KbfReferenceV1>, 'ready' | 'check'> => ({
  ready: async () => ({ applies: true }) as never,
  check: async () => record,
})

test('a seller-side no result blocks SAME: an audit whose active cap check gave this seller nothing is UNDETERMINED, not a failure', async () => {
  // The cap check's reference applied (no reason file), and the seller gave it nothing: active, not run for it.
  const { result, evidence } = await audit({ usage: MODEL_TOKENIZER, outputCap: capScreen(null) })
  assert.equal(result.questionsStatus, 'SAME')
  assert.equal(result.status, 'UNDETERMINED')
  assert.equal(result.outcomeReason, null, 'finished: it is submitted as UNDETERMINED, not audited again as a failure')
  assert.equal(evidence.noRecord?.some((entry) => entry.slot === 'outputCap'), false, 'a seller-side cause is never in noRecord')
  assert.equal(result.inactive?.some((entry) => entry.check === 'output-cap'), false)
  const verdict = verdictOf(readingsOfEvidence(evidence, 'SAME'), 'SAME')
  assert.deepEqual(verdict.openTests, ['output-cap'])
  assert.match(auditVerdictReason(evidence, verdict, null)!, /the cap check did not run for this seller$/)
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
  // The same seller with the cap check passed is SAME: the tests without a screen this run are not active.
  const passed = await audit({ usage: MODEL_TOKENIZER, outputCap: capScreen({ ...cap('pass'), asks: [] }) })
  assert.equal(passed.result.status, 'SAME')
  assert.deepEqual(passed.result.inactive?.map((entry) => entry.check), ['output-echo', 'output-offset', 'flips'])
})

test('FLIPS is flag-only: counted and with no result beside every other test passed it is SAME; a counted FLIPS flag is DIFF', () => {
  // Every other test passed, FLIPS counts for the model and gave this seller nothing (no record): SAME.
  const passed = evidenceOf({ tokenizerPrecheck: precheck('match', ALL_ROUNDS), outputCap: cap('pass'), outputEcho: echo('plain', 'pass', 'pass') }, { model: 'claude-opus-5.5' })
  const readings = readingsOfEvidence(passed, 'SAME', { flips: FLIPS_COUNTING })
  const flips = readings.find((reading) => reading.check === 'flips')!
  assert.deepEqual([verdictOf(readings, 'SAME').verdict, verdictOf(readings, 'SAME').openTests], ['SAME', undefined])
  assert.deepEqual([flips.outcome, flips.inactive, flips.flagOnly], ['not-run', undefined, true], 'active, flag-only')
  // Its flag still makes a DIFF.
  const flagged = readings.map((reading) => (reading.check === 'flips' ? { ...reading, outcome: 'flag' as const } : reading))
  assert.deepEqual([verdictOf(flagged, 'SAME').verdict, verdictOf(flagged, 'SAME').flaggedBy], ['DIFF', ['flips']])
  // Another active test with no result still blocks: only FLIPS is flag-only.
  const open = readings.map((reading) => (reading.check === 'output-cap' ? { ...reading, outcome: 'inconclusive' as const } : reading))
  assert.deepEqual(verdictOf(open, 'SAME').openTests, ['output-cap'])
})

test('a flag is still a DIFF, whatever else is open', async () => {
  const flagged = evidenceOf({ outputCap: cap('flag'), outputEcho: echo('plain', 'inconclusive', 'inconclusive') })
  const verdict = verdictOf(readingsOfEvidence(flagged, 'SAME'), 'SAME')
  assert.deepEqual([verdict.verdict, verdict.flaggedBy, verdict.openTests], ['DIFF', ['output-cap'], undefined])
  // A real pre-check mismatch backed by the model's other seller, beside a cap check that gave nothing: DIFF.
  const { result } = await audit({ usage: OTHER_TOKENIZER, outputCap: capScreen(null) })
  assert.equal(result.status, 'DIFF')
})

test('a confirmation follows the same rule: its repeated test passed and another active test did not decide, so nothing is sent', () => {
  const reading = (check: AuditCheckId, outcome: 'pass' | 'inconclusive' | 'not-run', inactive = false) => ({
    check, subject: 'model' as const, outcome, ...(inactive ? { inactive: { cause: 'run' as const, reason: 'switched off' } } : {}),
  })
  const open = verdictOf([reading('output-cap', 'pass'), reading('output-echo', 'inconclusive'), reading('kbf', 'pass')], 'SAME', ['output-cap'])
  assert.deepEqual([open.verdict, open.undecidedConfirmation, open.openTests], ['UNDETERMINED', null, ['output-echo']])
  const closed = verdictOf([reading('output-cap', 'pass'), reading('output-echo', 'inconclusive', true), reading('kbf', 'pass')], 'SAME', ['output-cap'])
  assert.equal(closed.verdict, 'SAME')
  // The same-check decision never sends such a result, and says why.
  const decision = decide(
    { agentId: 1n, serviceHash: '0x00', verdict: VERIFIER_VERDICT.UNDETERMINED, auditedAt: 20_000, flaggedBy: [], passedBy: ['output-cap', 'kbf'], confirming: { checks: ['output-cap'], reportedAt: 100 } },
    [{ auditor: '0x00', peerId: '00'.repeat(20), evidenceUri: 'ipfs://x', evidenceHash: '0x00', reportedAt: 100, checks: ['output-cap'] }],
  )
  assert.equal(decision.kind, 'exclude')
  assert.match(decision.kind === 'exclude' ? decision.reason : '', /passed here, but another active test did not decide, and a SAME needs every active test passed/)
})

test('verifier submit refuses a result whose verdict does not follow from its tests, or whose active tests are not its evidence\'s', async () => {
  const { result, evidence } = await audit({ usage: MODEL_TOKENIZER, outputCap: capScreen(null) })
  assert.equal(result.status, 'UNDETERMINED')
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
  // A SAME claimed beside an active test that did not run for the seller.
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, status: 'SAME' }), /verdict mismatch/)
  // The cap check claimed not active, which its evidence does not say.
  assert.throws(() => validateAuditMatchesSummary(evidence, {
    ...result, status: 'SAME', inactive: [{ check: 'output-cap', cause: 'run', reason: 'claimed' }, ...result.inactive!],
  }), /active tests are not the ones its evidence gives/)
  // A summary that does not say which tests were active is judged by no rule here.
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, inactive: undefined }), /does not say which tests were active/)
  // Evidence that names a test without a record beside that test's record.
  const both = { ...evidence, noRecord: [...(evidence.noRecord ?? []), { slot: 'tokenizerPrecheck', reason: 'claimed' }] }
  assert.throws(() => validateAuditMatchesSummary(both, { ...result, inactive: inactiveChecks(both) }), /without a record beside its record/)
})
