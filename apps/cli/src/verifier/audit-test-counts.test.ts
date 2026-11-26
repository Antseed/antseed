import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { VERIFIER_VERDICT } from '@antseed/node/payments'
import { AUDIT_CHECK_IDS, inactiveChecks, readingsOfEvidence, verdictOf, type ActiveTestsInput, type AuditCheckId } from './audit-checks.js'
import { AUDIT_TEST_COUNTS, notCountedReason, testBlocksSame, testCounts } from './audit-test-counts.js'
import { OUTPUT_ECHO_RULE } from './methods/output-echo/output-echo.js'
import { decide, type FirstFlag } from './same-check.js'
import { METHODS } from './methods/index.js'
import { OUTPUT_CAP_RULE, type OutputCapV1 } from './methods/output-cap/output-cap.js'
import { TOKENIZER_PRECHECK_RULE, type TokenizerPrecheckV1 } from './methods/tokens/tokenizer-precheck.js'
import { prepareModelAudits } from './model-audit.js'
import { FIXTURE_CONFIG, peerIdOf, writeSignedAuditRun } from './model-audit-fixtures.test-support.js'
import { SERVICE, signedFlipsRecord } from './methods/shared/output-checks.test-support.js'
import { verifierRulesHash } from './verifier-compat.js'

/**
 * The table of how each test takes part in the verdict (`AUDIT_TEST_COUNTS`, Alex, 24 and 25 November): a test that does
 * not count still runs, is judged, stored and published, never makes a DIFF and never blocks a SAME, and is named as not
 * active; a test whose `blocksSame` is false (all of them today) never blocks a SAME with no result. A confirmation always
 * sends what its audit decided.
 */

const ALL_ROUNDS = Array.from({ length: TOKENIZER_PRECHECK_RULE.rounds }, (_, index) => 100 + index)
const precheck = (outcome: TokenizerPrecheckV1['outcome']): TokenizerPrecheckV1 => ({
  rule: TOKENIZER_PRECHECK_RULE, outcome, reason: outcome === 'inconclusive' ? 'the seller signed different counts for the same text' : null, referenceUpstream: null,
  rounds: ALL_ROUNDS.map((delta) => ({ reference: { asks: [], delta, failure: null }, seller: [] })),
} as never)
const cap = (outcome: OutputCapV1['outcome']): OutputCapV1 => ({ rule: OUTPUT_CAP_RULE, outcome, reason: `cap ${outcome}`, asks: [] } as never)
/** Seller evidence with a pre-check and a cap check beside the questions; the run had no echo check or FLIPS for the model. */
const evidenceOf = (records: Record<string, unknown>) => ({
  ...records,
  reference: { referenceModel: 'example-model' },
  noRecord: [{ slot: 'outputEcho', reason: 'not run for the model in this sample' }, { slot: 'flips', reason: 'not run for the model in this sample' }],
  exchanges: [{}],
}) as ActiveTestsInput & { exchanges: unknown[] }

test('the table holds every test with a record: the cap check and FLIPS do not count today, and no test blocks a SAME', () => {
  const findings = METHODS.flatMap((check) => check.findings.map((finding) => finding.id))
  assert.deepEqual(Object.keys(AUDIT_TEST_COUNTS).sort(), [...findings].sort(), 'one entry per finding, none missing')
  assert.deepEqual(AUDIT_TEST_COUNTS, {
    tokens: { counts: true, blocksSame: false },
    'output-cap': { counts: false, blocksSame: false },
    'output-echo': { counts: true, blocksSame: false },
    'output-offset': { counts: true, blocksSame: false },
    flips: { counts: false, blocksSame: false },
  })
  for (const id of findings) assert.equal(testBlocksSame(id), false, id)
  assert.equal(testBlocksSame('kbf'), true, 'the questions decide a SAME themselves')
  assert.ok(AUDIT_CHECK_IDS.includes('kbf'))
  assert.equal(testCounts('kbf'), true, 'the questions are not in the table and always count')
  assert.ok(Object.isFrozen(AUDIT_TEST_COUNTS), 'no run can change it')
})

test('a test whose entry is false never makes a DIFF and never blocks a SAME, and is not active by the rule', () => {
  const off = { counts: { tokens: false } }
  // A pre-check mismatch the table does not count: recorded only, no DIFF.
  const mismatch = evidenceOf({ tokenizerPrecheck: precheck('mismatch'), outputCap: cap('pass') })
  assert.equal(verdictOf(readingsOfEvidence(mismatch, 'SAME'), 'SAME').verdict, 'DIFF', 'counted, it is a DIFF')
  const recorded = readingsOfEvidence(mismatch, 'SAME', off)
  assert.deepEqual(recorded.filter((reading) => reading.check === 'tokens').map((reading) => [reading.outcome, reading.recordedOnly, reading.inactive]),
    [['inconclusive', 'flag', { cause: 'rule', reason: notCountedReason('the token-count pre-check') }]])
  assert.deepEqual(verdictOf(recorded, 'SAME'), { verdict: 'SAME', flaggedBy: [], passedBy: ['kbf'], undecidedConfirmation: null })
  // A pre-check with no result blocks nothing, counted or not.
  const open = evidenceOf({ tokenizerPrecheck: precheck('inconclusive'), outputCap: cap('pass') })
  assert.equal(verdictOf(readingsOfEvidence(open, 'SAME'), 'SAME').verdict, 'SAME')
  assert.equal(verdictOf(readingsOfEvidence(open, 'SAME', off), 'SAME').verdict, 'SAME')
  assert.deepEqual(inactiveChecks(open, off).find((entry) => entry.check === 'tokens'),
    { check: 'tokens', cause: 'rule', reason: 'the token-count pre-check is recorded only for now: the audit rules do not count it toward the verdict' })
  // A pass it does not count is no pass either.
  const passed = evidenceOf({ tokenizerPrecheck: precheck('match'), outputCap: cap('pass') })
  assert.deepEqual(verdictOf(readingsOfEvidence(passed, 'SAME', off), 'SAME').passedBy, ['kbf'])
})

test('the cap check today: its flag alone gives no DIFF, its no result never blocks a SAME, and it is published as not active by the rule', () => {
  const flagged = evidenceOf({ tokenizerPrecheck: precheck('match'), outputCap: cap('flag') })
  const readings = readingsOfEvidence(flagged, 'SAME')
  assert.deepEqual(readings.filter((reading) => reading.check === 'output-cap').map((reading) => [reading.outcome, reading.recordedOnly, reading.inactive?.cause]),
    [['inconclusive', 'flag', 'rule']])
  assert.deepEqual(verdictOf(readings, 'SAME'), { verdict: 'SAME', flaggedBy: [], passedBy: ['tokens', 'kbf'], undecidedConfirmation: null })
  assert.deepEqual(inactiveChecks(flagged).find((entry) => entry.check === 'output-cap'),
    { check: 'output-cap', cause: 'rule', reason: 'the cap check is recorded only for now: the audit rules do not count it toward the verdict' })
  assert.equal(verdictOf(readingsOfEvidence(evidenceOf({ tokenizerPrecheck: precheck('match'), outputCap: cap('inconclusive') }), 'SAME'), 'SAME').verdict, 'SAME')
  // Read under a table that counts it: its flag is a DIFF again.
  assert.equal(verdictOf(readingsOfEvidence(flagged, 'SAME', { counts: { 'output-cap': true } }), 'SAME').verdict, 'DIFF')
})

test('if the questions pass and nothing that counts flags, it is SAME: a pre-check or echo check with no result blocks nothing; a pre-check flag is DIFF', () => {
  const echo = (growth: string) => ({ rule: OUTPUT_ECHO_RULE, mode: 'plain', outcome: growth, flag: growth === 'flag' ? 'growth' : null, growth: { outcome: growth, reason: `growth ${growth}` }, fixedAmount: { outcome: 'pass', reason: 'fixed pass' }, rounds: [], crowd: null }) as never
  const verdict = (records: Record<string, unknown>) => verdictOf(readingsOfEvidence({ ...evidenceOf(records), noRecord: [{ slot: 'flips', reason: 'x' }] }, 'SAME'), 'SAME')
  assert.equal(verdict({ tokenizerPrecheck: precheck('inconclusive') }).verdict, 'SAME', 'questions SAME + pre-check no result')
  assert.equal(verdict({ tokenizerPrecheck: precheck('match'), outputEcho: echo('inconclusive') }).verdict, 'SAME', 'questions SAME + echo no result')
  assert.deepEqual([verdict({ tokenizerPrecheck: precheck('mismatch') }).verdict, verdict({ tokenizerPrecheck: precheck('mismatch') }).flaggedBy], ['DIFF', ['tokens']], 'questions SAME + pre-check flag')
  assert.deepEqual(verdict({ tokenizerPrecheck: precheck('match'), outputEcho: echo('flag') }).flaggedBy, ['output-echo'])
})

/** As the confirmer's audit decides it, then what the same-check decision sends for it against the waiting DIFF. */
function confirmerSends(records: Record<string, unknown>, questions: 'SAME' | 'DIFF' | 'UNDETERMINED', repeats: AuditCheckId[]) {
  const evidence = { ...evidenceOf(records), noRecord: [{ slot: 'flips', reason: 'x' }] }
  const readings = readingsOfEvidence(evidence, questions === 'UNDETERMINED' ? null : questions)
  const audit = verdictOf(readings, questions, repeats)
  const first: FirstFlag = { auditor: '0x' + '0a'.repeat(20), peerId: '00'.repeat(20), evidenceUri: 'ipfs://first', evidenceHash: '0x00', reportedAt: 1_000, checks: repeats }
  const decision = decide({
    agentId: 1n, serviceHash: '0x00', verdict: VERIFIER_VERDICT[audit.verdict], auditedAt: 1_000 + 7_200,
    flaggedBy: audit.flaggedBy, passedBy: audit.passedBy, confirming: { checks: repeats, reportedAt: 1_000 },
  }, [first])
  return { verdict: audit.verdict, undecided: audit.undecidedConfirmation, kind: decision.kind, sameCheck: decision.kind === 'send' ? decision.confirmation.sameCheck : null }
}

test('a confirmation always sends: (1) its repeat flags again, DIFF', () => {
  assert.deepEqual(confirmerSends({ tokenizerPrecheck: precheck('mismatch') }, 'SAME', ['tokens']), { verdict: 'DIFF', undecided: null, kind: 'send', sameCheck: 'tokens' })
})

test('a confirmation always sends: (2) the repeated test passes, SAME, whatever another test flagged; or the questions say SAME and nothing flags', () => {
  // A flagged pre-check passes with the questions SAME.
  assert.deepEqual(confirmerSends({ tokenizerPrecheck: precheck('match') }, 'SAME', ['tokens']), { verdict: 'SAME', undecided: null, kind: 'send', sameCheck: null })
  // A questions DIFF whose questions pass here while the pre-check flags: SAME, clearing it; the pre-check's flag is asked again later.
  assert.deepEqual(confirmerSends({ tokenizerPrecheck: precheck('mismatch') }, 'SAME', ['kbf']), { verdict: 'SAME', undecided: null, kind: 'send', sameCheck: null })
  // A flagged cap check (from before it stopped counting) "passes" on the repeat with the pre-check undecided: the cap
  // check decides nothing now, the questions say SAME and nothing that counts flags: SAME.
  assert.deepEqual(confirmerSends({ tokenizerPrecheck: precheck('inconclusive'), outputCap: cap('pass') }, 'SAME', ['output-cap']), { verdict: 'SAME', undecided: null, kind: 'send', sameCheck: null })
})

test('a confirmation always sends: (3) another counting test flags while the repeat did not pass, UNDETERMINED, never that DIFF', () => {
  assert.deepEqual(confirmerSends({ tokenizerPrecheck: precheck('mismatch'), outputCap: cap('inconclusive') }, 'SAME', ['output-cap']),
    { verdict: 'UNDETERMINED', undecided: ['output-cap'], kind: 'send', sameCheck: null })
})

test('a confirmation always sends: (4) nothing decided (the questions undecided), UNDETERMINED, its last attempt sent through submit', async () => {
  assert.deepEqual(confirmerSends({ tokenizerPrecheck: precheck('inconclusive') }, 'UNDETERMINED', ['kbf']), { verdict: 'UNDETERMINED', undecided: ['kbf'], kind: 'send', sameCheck: null })
  // Through submit's preparation: the undecided confirmation's last attempt is published and sent, answering the report.
  const directory = await mkdtemp(join(tmpdir(), 'antseed-confirmation-sends-'))
  try {
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const seller = new Wallet(Wallet.createRandom().privateKey)
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const manifest = await writeSignedAuditRun({
      evidenceDir, banksDir, runId: 'run-1', epoch: '7', auditor,
      audits: [{ agentId: '1', seller, model: 'model-a', service: 'model-a', verdict: 'UNDETERMINED', confirmsDiff: true, confirming: { checks: ['kbf'], reportedAt: 1_000 } }],
    })
    const first: FirstFlag = { auditor: '0x' + '0a'.repeat(20), peerId: peerIdOf(seller), evidenceUri: 'ipfs://first', evidenceHash: '0x00', reportedAt: 1_000, checks: ['kbf'] }
    const prepared = await prepareModelAudits({
      evidenceDir, banksDir, manifest, auditor: auditor.address, config: FIXTURE_CONFIG,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address,
      sameCheck: async (_model, candidates) => candidates.map((candidate) => decide(candidate, [first])),
    })
    assert.deepEqual(prepared.excluded, [])
    const sent = prepared.audits[0]!.evidence.results[0]!
    assert.equal(sent.verdict, 'UNDETERMINED')
    assert.equal(sent.outcomeReason?.code, 'confirmation_undecided')
    assert.deepEqual([sent.confirmation?.firstChecks, sent.confirmation?.sameCheck], [['kbf'], null])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('FLIPS today: a signed FLIPS flag is judged and stored, published as not active by the rule, and the seller is SAME', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-test-counts-'))
  try {
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const seller = new Wallet(Wallet.createRandom().privateKey)
    const model = 'claude-opus-5.5'
    // A seller that is no random source: it flags at the first bar, and FLIPS's own rule counts this model.
    const flips = signedFlipsRecord({
      draw: { auditor: auditor.address, model, epoch: '7', seed: 'counts', stage: 'first' }, service: SERVICE, peerId: peerIdOf(seller),
      seller, buyer: auditor.address,
      reply: (pair, slot) => Array.from({ length: 64 }, (_, index) => pair[index === slot || index === 63 - slot * 2 ? 1 : 0]).join(' '),
    })
    assert.deepEqual([flips.outcome, flips.counted], ['flag', true])
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const manifest = await writeSignedAuditRun({
      evidenceDir, banksDir, runId: 'run-1', epoch: '7', auditor,
      audits: [{ agentId: '1', seller, model, service: SERVICE, verdict: 'SAME', questionsVerdict: 'SAME', flips }],
    })
    const prepared = await prepareModelAudits({
      evidenceDir, banksDir, manifest, auditor: auditor.address, config: FIXTURE_CONFIG,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address,
    })
    assert.deepEqual(prepared.excluded, [])
    const published = prepared.audits[0]!.evidence.results[0]!
    assert.deepEqual([published.verdict, published.flaggedBy], ['SAME', []])
    assert.deepEqual(published.inactive?.find((entry) => entry.check === 'flips'),
      { check: 'flips', cause: 'rule', reason: 'the randomness check is recorded only for now: the audit rules do not count it toward the verdict' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the table is part of the audit rules: changing any entry changes the rules hash', () => {
  const pinned = verifierRulesHash()
  assert.equal(verifierRulesHash({ testCounts: AUDIT_TEST_COUNTS }), pinned)
  for (const id of Object.keys(AUDIT_TEST_COUNTS) as Array<keyof typeof AUDIT_TEST_COUNTS>) {
    for (const key of ['counts', 'blocksSame'] as const) {
      const entry = AUDIT_TEST_COUNTS[id]
      assert.notEqual(verifierRulesHash({ testCounts: { ...AUDIT_TEST_COUNTS, [id]: { ...entry, [key]: !entry[key] } } }), pinned, `${id} ${key}`)
    }
  }
})
