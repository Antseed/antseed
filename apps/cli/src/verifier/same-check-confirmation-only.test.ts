import assert from 'node:assert/strict'
import test from 'node:test'
import { VERIFIER_VERDICT, type VerifierVerdict } from '@antseed/node/payments'
import {
  CONFIRMATION_ONLY_FINDINGS, type AuditCheckId, type CheckFinding, type ConfirmationOnlyFinding,
} from './audit-checks.js'
import { METHODS } from './methods/index.js'
import { decide, type FirstFlag, type SameCheckCandidate, type SameCheckDecision, type SameCheckExcludeCode } from './same-check.js'

const REPORTED_AT = Date.parse('2026-10-07T00:10:00.000Z') / 1_000
/** Every audit here is made two hours after the report it answers: fresh. */
const AUDITED_AT = REPORTED_AT + 2 * 60 * 60

const waiting = (...checks: AuditCheckId[]): FirstFlag => ({
  auditor: `0x${'a'.repeat(40)}`, peerId: 'aa'.repeat(20), evidenceUri: 'ipfs://bafyexample', evidenceHash: `0x${'1'.repeat(64)}`, reportedAt: REPORTED_AT, checks,
})

/** One audit's result: a first look, or with `confirming` a confirmation of those tests for the waiting report. */
const audit = (verdict: VerifierVerdict, flaggedBy: AuditCheckId[], passedBy: AuditCheckId[], confirming?: AuditCheckId[]): SameCheckCandidate => ({
  agentId: 2n, serviceHash: `0x${'5'.repeat(64)}`, verdict, auditedAt: AUDITED_AT, flaggedBy, passedBy,
  ...(confirming ? { confirming: { checks: confirming, reportedAt: REPORTED_AT } } : {}),
})

/** A decision in short: its kind, then its code, or the test that confirmed or cleared. */
const short = (decision: SameCheckDecision): unknown[] => [
  decision.kind,
  decision.kind === 'exclude' ? decision.code : decision.kind === 'send' ? decision.confirmation.sameCheck ?? decision.confirmation.passedCheck : null,
]

const { SAME, DIFF } = VERIFIER_VERDICT

/**
 * Stand-ins for the list: the pre-check and the cap check read as tests only a confirmation answers, and FLIPS as one a
 * first look answers. The decision reads which tests those are from the list it is given, so the rule can be shown for
 * two such tests, which the real list does not have. The type holds a marked finding to the real list's ids, hence the
 * cast.
 */
const STAND_INS = [
  { id: 'tokens', label: 'the first stand-in', confirmationOnly: { material: 'material of the first' } },
  { id: 'output-cap', label: 'the second stand-in', confirmationOnly: { material: 'material of the second' } },
] as unknown as readonly ConfirmationOnlyFinding[]
const standIn = (candidate: SameCheckCandidate, ...firsts: FirstFlag[]) => decide(candidate, firsts, STAND_INS)

test('the list marks FLIPS, and no other test, as answered only by a confirmation', () => {
  assert.deepEqual(CONFIRMATION_ONLY_FINDINGS.map((finding) => finding.id), ['flips'])
  assert.deepEqual(CONFIRMATION_ONLY_FINDINGS.map((finding) => finding.confirmationOnly), [{ material: 'fresh pairs, 40 replies' }])
  const marked = METHODS.flatMap((check) => (check.findings as readonly CheckFinding<'flips'>[]).filter((finding) => finding.confirmationOnly !== undefined))
  assert.deepEqual(marked.map((finding) => finding.id), ['flips'])
  // The compiler holds the list and the codes to it: another finding cannot carry the mark, FLIPS cannot drop it, and
  // no code exists for a test without it.
  const reads = { subject: 'model' as const, label: 'x', ofRecord: () => 'pass' as const, ofSummary: () => 'pass' as const }
  const asListed: CheckFinding<'flips'>[] = [{ id: 'tokens', ...reads }, { id: 'flips', ...reads, confirmationOnly: { material: 'x' } }]
  // @ts-expect-error a finding outside `ConfirmationOnlyCheckId` with the mark
  const other: CheckFinding<'flips'> = { id: 'tokens', ...reads, confirmationOnly: { material: 'x' } }
  // @ts-expect-error the FLIPS finding without the mark
  const unmarked: CheckFinding<'flips'> = { id: 'flips', ...reads }
  // @ts-expect-error no such code
  const code: SameCheckExcludeCode = 'tokens-not-confirmation'
  assert.ok(asListed && other && unmarked && code)
})

test('a first look of FLIPS answers no waiting FLIPS flag, with the stored code and reason', () => {
  const reason = 'the waiting DIFF was flagged by the randomness check, which only a confirmation of it (fresh pairs, 40 replies) '
    + 'answers; this first look is not sent, and the seller is audited again as a confirmation'
  for (const candidate of [audit(DIFF, ['flips'], ['kbf']), audit(SAME, [], ['flips', 'kbf'])]) {
    const decision = decide(candidate, [waiting('flips')])
    assert.equal(decision.kind, 'exclude')
    if (decision.kind !== 'exclude') continue
    const code: SameCheckExcludeCode = 'flips-not-confirmation'
    assert.equal(decision.code, code)
    assert.equal(decision.reason, reason)
    assert.deepEqual(decision.confirmation, {
      auditor: waiting().auditor, evidenceUri: 'ipfs://bafyexample', evidenceHash: waiting().evidenceHash, reportedAt: REPORTED_AT,
      firstChecks: ['flips'], ownChecks: candidate.flaggedBy, sameCheck: null,
    })
  }
  // A confirmation of FLIPS answers it: its flag confirms, its pass clears.
  assert.deepEqual(short(decide(audit(DIFF, ['flips'], ['kbf'], ['flips']), [waiting('flips')])), ['send', 'flips'])
  assert.deepEqual(short(decide(audit(SAME, [], ['flips', 'kbf'], ['flips']), [waiting('flips')])), ['send', 'flips'])
  // A test without the mark is answered by a first look.
  assert.deepEqual(short(decide(audit(DIFF, ['tokens'], []), [waiting('tokens')])), ['send', 'tokens'])
  assert.deepEqual(short(decide(audit(SAME, [], ['tokens', 'kbf']), [waiting('tokens')])), ['send', 'tokens'])
})

test('the decision reads the mark from the list it is given, and names no test', () => {
  // The marked stand-in: a first look's flag or pass of it answers nothing, and the code and reason are built from it.
  for (const candidate of [audit(DIFF, ['tokens'], ['kbf']), audit(SAME, [], ['tokens', 'kbf'])]) {
    const decision = standIn(candidate, waiting('tokens'))
    assert.deepEqual(short(decision), ['exclude', 'tokens-not-confirmation'])
    assert.equal(decision.kind === 'exclude' ? decision.reason : '', 'the waiting DIFF was flagged by the first stand-in, which only a confirmation of it '
      + '(material of the first) answers; this first look is not sent, and the seller is audited again as a confirmation')
  }
  // Only a confirmation of it answers: its flag confirms, its pass clears.
  assert.deepEqual(short(standIn(audit(DIFF, ['tokens'], ['kbf'], ['tokens']), waiting('tokens'))), ['send', 'tokens'])
  assert.deepEqual(short(standIn(audit(SAME, [], ['tokens', 'kbf'], ['tokens']), waiting('tokens'))), ['send', 'tokens'])
  // FLIPS is not marked in this list, so here a first look answers it, as it answers the questions.
  assert.deepEqual(short(standIn(audit(DIFF, ['flips'], ['kbf']), waiting('flips'))), ['send', 'flips'])
  assert.deepEqual(short(standIn(audit(SAME, [], ['flips', 'kbf']), waiting('flips'))), ['send', 'flips'])
  assert.deepEqual(short(standIn(audit(DIFF, ['kbf'], []), waiting('kbf'))), ['send', 'kbf'])
  // A test without the mark that the waiting DIFF also names still confirms from a first look.
  assert.deepEqual(short(standIn(audit(DIFF, ['tokens', 'kbf'], []), waiting('tokens', 'kbf'))), ['send', 'kbf'])
  // A first look that passes both clears neither: the marked one stays unanswered.
  assert.deepEqual(short(standIn(audit(SAME, [], ['tokens', 'kbf']), waiting('tokens', 'kbf'))), ['exclude', 'tokens-not-confirmation'])
  // A first look that did not decide the marked test is open like any other test.
  assert.deepEqual(short(standIn(audit(SAME, [], ['kbf']), waiting('tokens'))), ['exclude', 'repeated-test-open'])
  // With an empty list every test is answered by a first look.
  assert.deepEqual(short(decide(audit(DIFF, ['flips'], []), [waiting('flips')], [])), ['send', 'flips'])
})

test('two tests only a confirmation answers: each is answered only by a confirmation of that one', () => {
  // A first look of both, where both flags wait: neither is answered. The first in attribution order names the code.
  assert.deepEqual(short(standIn(audit(DIFF, ['tokens', 'output-cap'], []), waiting('tokens', 'output-cap'))), ['exclude', 'tokens-not-confirmation'])
  assert.deepEqual(short(standIn(audit(DIFF, ['output-cap'], []), waiting('tokens', 'output-cap'))), ['exclude', 'output-cap-not-confirmation'])
  assert.deepEqual(short(standIn(audit(SAME, [], ['tokens', 'output-cap']), waiting('tokens', 'output-cap'))), ['exclude', 'tokens-not-confirmation'])
  // Two reports, one flag each: each report is held to its own test, and the first one not sent decides.
  assert.deepEqual(short(standIn(audit(SAME, [], ['tokens', 'output-cap']), waiting('tokens'), waiting('output-cap'))), ['exclude', 'tokens-not-confirmation'])
  assert.deepEqual(short(standIn(audit(SAME, [], ['tokens', 'output-cap']), waiting('output-cap'), waiting('tokens'))), ['exclude', 'output-cap-not-confirmation'])
  // A confirmation of both answers both.
  assert.deepEqual(short(standIn(audit(DIFF, ['tokens', 'output-cap'], [], ['tokens', 'output-cap']), waiting('tokens', 'output-cap'))), ['send', 'tokens'])
  assert.deepEqual(short(standIn(audit(DIFF, ['output-cap'], ['tokens'], ['tokens', 'output-cap']), waiting('tokens', 'output-cap'))), ['send', 'output-cap'])
  assert.deepEqual(short(standIn(audit(SAME, [], ['tokens', 'output-cap'], ['tokens', 'output-cap']), waiting('tokens', 'output-cap'))), ['send', 'tokens'])
  // A confirmation of one while the other's flag waits too was made for another set of tests than the waiting ones:
  // the rule above this one leaves it out, so neither flag is answered by it.
  assert.deepEqual(short(standIn(audit(DIFF, ['tokens', 'output-cap'], [], ['tokens']), waiting('tokens', 'output-cap'))), ['exclude', 'confirms-another-report'])
  assert.deepEqual(short(standIn(audit(DIFF, ['tokens'], [], ['tokens']), waiting('tokens'), waiting('output-cap'))), ['exclude', 'confirms-another-report'])
  // A confirmation of one, where only that one's flag waits: it is answered. The other, a first look in the same audit,
  // answers nothing: its flag confirms nothing and is another test's, and its pass is not needed.
  const both = standIn(audit(DIFF, ['tokens', 'output-cap'], [], ['tokens']), waiting('tokens'))
  assert.deepEqual(short(both), ['send', 'tokens'])
  assert.deepEqual(both.kind === 'send' ? both.confirmation.ownChecks : null, ['tokens', 'output-cap'])
  assert.deepEqual(short(standIn(audit(DIFF, ['output-cap'], ['tokens'], ['tokens']), waiting('tokens'))), ['exclude', 'other-test-only'])
  assert.deepEqual(short(standIn(audit(SAME, [], ['tokens', 'output-cap'], ['tokens']), waiting('tokens'))), ['send', 'tokens'])
  // The same audit against the other test's flag: its confirmation was not made for it.
  assert.deepEqual(short(standIn(audit(DIFF, ['output-cap'], ['tokens'], ['tokens']), waiting('output-cap'))), ['exclude', 'confirms-another-report'])
})
