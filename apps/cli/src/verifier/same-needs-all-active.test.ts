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
/** A reading under a table that counts FLIPS and a FLIPS rule that counts it (`ReadingRules`): how FLIPS decides once it counts. */
const COUNTING_READ = { flips: FLIPS_COUNTING, counts: { flips: true } }

test('an active test with no result never blocks a SAME today (`blocksSame` false); one the table required would, naming it', () => {
  const passed = evidenceOf({ tokenizerPrecheck: precheck('match', ALL_ROUNDS), outputCap: cap('pass'), outputEcho: echo('plain', 'pass', 'pass') })
  // The cap check and FLIPS do not count (the table): not active, so they block nothing.
  assert.deepEqual(inactiveChecks(passed).map((entry) => [entry.check, entry.cause]), [['output-cap', 'rule'], ['flips', 'rule']])
  assert.equal(verdictOf(readingsOfEvidence(passed, 'SAME'), 'SAME').verdict, 'SAME')
  const open = evidenceOf({
    tokenizerPrecheck: precheck('match', ALL_ROUNDS), outputCap: cap('pass'),
    outputEcho: echo('plain', 'inconclusive', 'pass', { growth: 'a round was under' }),
  })
  const readings = readingsOfEvidence(open, 'SAME')
  assert.deepEqual([verdictOf(readings, 'SAME').verdict, verdictOf(readings, 'SAME').openTests], ['SAME', undefined])
  // Were the echo check required again (`blocksSame` true): UNDETERMINED, its reason naming the test.
  const required = readings.map(({ flagOnly: _flagOnly, ...reading }) => reading)
  const verdict = verdictOf(required, 'SAME')
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
  // Read under a table and a FLIPS rule that count: it still never counts for GPT-6.2 Sol, which the eval never measured.
  const inactive = inactiveChecks(evidence, COUNTING_READ)
  assert.deepEqual(inactive, [
    { check: 'tokens', cause: 'run', reason: 'no reference to compare with: the reference gave no difference' },
    // The table first: the cap check does not count, whatever its reference said.
    { check: 'output-cap', cause: 'rule', reason: 'the cap check is recorded only for now: the audit rules do not count it toward the verdict' },
    { check: 'output-offset', cause: 'rule', reason: 'the fixed amount is not judged for a model whose reference shows its reasoning: its echoes are counted on the visible answer' },
    { check: 'flips', cause: 'rule', reason: 'the randomness check is recorded only: its rule does not count it for this model' },
  ])
  assert.equal(verdictOf(readingsOfEvidence(evidence, 'SAME', COUNTING_READ), 'SAME').verdict, 'SAME')
  // On a model the counting rule measures, FLIPS is active; it is flag-only, so no FLIPS for the seller blocks nothing.
  const measured = { ...evidence, reference: { referenceModel: 'claude-opus-5.5' } }
  assert.equal(inactiveChecks(measured, COUNTING_READ).some((entry) => entry.check === 'flips'), false)
  const counted = verdictOf(readingsOfEvidence(measured, 'SAME', COUNTING_READ), 'SAME')
  assert.deepEqual([counted.verdict, counted.openTests], ['SAME', undefined])
  // A pre-check whose reference measured every round is active; its seller-side no result no longer blocks the SAME.
  const sellerSide = evidenceOf({ tokenizerPrecheck: precheck('inconclusive', ALL_ROUNDS, 'the seller signed different counts for the same text') },
    { noRecord: [{ slot: 'outputCap', reason: capOff }, { slot: 'outputEcho', reason: 'the reference did not echo cleanly' }] })
  assert.equal(inactiveChecks(sellerSide).some((entry) => entry.check === 'tokens'), false, 'active')
  const notBlocked = verdictOf(readingsOfEvidence(sellerSide, 'SAME'), 'SAME')
  assert.deepEqual([notBlocked.verdict, notBlocked.openTests], ['SAME', undefined])
})

/** Stand-in cap screens: the reference applied, and the seller's check gives `record` (null: nothing for this seller). */
const capScreen = (record: OutputCapV1 | null): Pick<OutputCapScreen<KbfReferenceV1>, 'ready' | 'check'> => ({
  ready: async () => ({ applies: true }) as never,
  check: async () => record,
})

test('a seller-side no result never blocks SAME: an audit whose cap check gave this seller nothing is SAME; the cap check is not active by the table', async () => {
  // The cap check's reference applied (no reason file), and the seller gave it nothing: not a seller-side `noRecord`.
  const { result, evidence } = await audit({ usage: MODEL_TOKENIZER, outputCap: capScreen(null) })
  assert.equal(result.questionsStatus, 'SAME')
  assert.equal(result.status, 'SAME')
  assert.equal(result.outcomeReason, null)
  assert.equal(evidence.noRecord?.some((entry) => entry.slot === 'outputCap'), false, 'a seller-side cause is never in noRecord')
  assert.equal(result.inactive?.find((entry) => entry.check === 'output-cap')?.cause, 'rule', 'the table does not count it')
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
  const passed = await audit({ usage: MODEL_TOKENIZER, outputCap: capScreen({ ...cap('pass'), asks: [] }) })
  assert.equal(passed.result.status, 'SAME')
  assert.deepEqual(passed.result.inactive?.map((entry) => entry.check), ['output-cap', 'output-echo', 'output-offset', 'flips'])
})

test('FLIPS is flag-only: counted and with no result beside every other test passed it is SAME; a counted FLIPS flag is DIFF', () => {
  // Every other test passed, FLIPS counts for the model and gave this seller nothing (no record): SAME.
  const passed = evidenceOf({ tokenizerPrecheck: precheck('match', ALL_ROUNDS), outputCap: cap('pass'), outputEcho: echo('plain', 'pass', 'pass') }, { model: 'claude-opus-5.5' })
  const readings = readingsOfEvidence(passed, 'SAME', COUNTING_READ)
  const flips = readings.find((reading) => reading.check === 'flips')!
  assert.deepEqual([verdictOf(readings, 'SAME').verdict, verdictOf(readings, 'SAME').openTests], ['SAME', undefined])
  assert.deepEqual([flips.outcome, flips.inactive, flips.flagOnly], ['not-run', undefined, true], 'active, flag-only')
  // Its flag still makes a DIFF.
  const flagged = readings.map((reading) => (reading.check === 'flips' ? { ...reading, outcome: 'flag' as const } : reading))
  assert.deepEqual([verdictOf(flagged, 'SAME').verdict, verdictOf(flagged, 'SAME').flaggedBy], ['DIFF', ['flips']])
  // Another active test with no result blocks nothing either: no test is required for a SAME today.
  const open = readings.map((reading) => (reading.check === 'tokens' ? { ...reading, outcome: 'inconclusive' as const } : reading))
  assert.deepEqual([verdictOf(open, 'SAME').verdict, verdictOf(open, 'SAME').openTests], ['SAME', undefined])
})

test('a flag of a counting test is still a DIFF, whatever else is open; a cap flag is not', async () => {
  const flagged = evidenceOf({ outputCap: cap('flag'), outputEcho: echo('plain', 'flag', 'inconclusive') })
  const verdict = verdictOf(readingsOfEvidence(flagged, 'SAME'), 'SAME')
  assert.deepEqual([verdict.verdict, verdict.flaggedBy, verdict.openTests], ['DIFF', ['output-echo'], undefined])
  // A real pre-check mismatch backed by the model's other seller, beside a cap check that gave nothing: DIFF.
  const { result } = await audit({ usage: OTHER_TOKENIZER, outputCap: capScreen(null) })
  assert.equal(result.status, 'DIFF')
})

test('a confirmation whose repeated test passed while another test did not decide is a SAME, and it is sent', () => {
  const reading = (check: AuditCheckId, outcome: 'pass' | 'inconclusive' | 'not-run', inactive = false) => ({
    check, subject: 'model' as const, outcome, ...(inactive ? { inactive: { cause: 'run' as const, reason: 'switched off' } } : {}),
  })
  const open = verdictOf([reading('tokens', 'pass'), reading('output-echo', 'inconclusive'), reading('kbf', 'pass')], 'SAME', ['tokens'])
  assert.deepEqual([open.verdict, open.undecidedConfirmation, open.openTests], ['SAME', null, undefined])
  // The same-check decision sends it, clearing the waiting DIFF.
  const decision = decide(
    { agentId: 1n, serviceHash: '0x00', verdict: VERIFIER_VERDICT.SAME, auditedAt: 20_000, flaggedBy: [], passedBy: ['tokens', 'kbf'], confirming: { checks: ['tokens'], reportedAt: 100 } },
    [{ auditor: '0x00', peerId: '00'.repeat(20), evidenceUri: 'ipfs://x', evidenceHash: '0x00', reportedAt: 100, checks: ['tokens'] }],
  )
  assert.deepEqual([decision.kind, decision.kind === 'send' ? decision.confirmation.passedCheck : null], ['send', 'tokens'])
})

test('verifier submit refuses a result whose verdict does not follow from its tests, or whose active tests are not its evidence\'s', async () => {
  const { result, evidence } = await audit({ usage: MODEL_TOKENIZER, outputCap: capScreen(null) })
  assert.equal(result.status, 'SAME')
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
  // A verdict its tests do not give.
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, status: 'UNDETERMINED' }), /verdict mismatch/)
  // The pre-check claimed not active, which its evidence does not say.
  assert.throws(() => validateAuditMatchesSummary(evidence, {
    ...result, inactive: [{ check: 'tokens', cause: 'run', reason: 'claimed' }, ...result.inactive!],
  }), /active tests are not the ones its evidence gives/)
  // A summary that does not say which tests were active is judged by no rule here.
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, inactive: undefined }), /does not say which tests were active/)
  // Evidence that names a test without a record beside that test's record.
  const both = { ...evidence, noRecord: [...(evidence.noRecord ?? []), { slot: 'tokenizerPrecheck', reason: 'claimed' }] }
  assert.throws(() => validateAuditMatchesSummary(both, { ...result, inactive: inactiveChecks(both) }), /without a record beside its record/)
})
