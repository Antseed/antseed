import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { AUDIT_CHECK_IDS, inactiveChecks, readingsOfEvidence, verdictOf, type ActiveTestsInput } from './audit-checks.js'
import { AUDIT_TEST_COUNTS, notCountedReason, testCounts } from './audit-test-counts.js'
import { METHODS } from './methods/index.js'
import { OUTPUT_CAP_RULE, type OutputCapV1 } from './methods/output-cap/output-cap.js'
import { TOKENIZER_PRECHECK_RULE, type TokenizerPrecheckV1 } from './methods/tokens/tokenizer-precheck.js'
import { prepareModelAudits } from './model-audit.js'
import { FIXTURE_CONFIG, peerIdOf, writeSignedAuditRun } from './model-audit-fixtures.test-support.js'
import { SERVICE, signedFlipsRecord } from './methods/shared/output-checks.test-support.js'
import { verifierRulesHash } from './verifier-compat.js'

/**
 * The table of which tests count toward the verdict (`AUDIT_TEST_COUNTS`, Alex, 24 November): a test whose entry is false
 * still runs, is judged, stored and published, never makes a DIFF and never blocks a SAME, and is named as not active.
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

test('the table holds every test with a record, the questions always count, and FLIPS does not count today', () => {
  const findings = METHODS.flatMap((check) => check.findings.map((finding) => finding.id))
  assert.deepEqual(Object.keys(AUDIT_TEST_COUNTS).sort(), [...findings].sort(), 'one entry per finding, none missing')
  assert.deepEqual(AUDIT_TEST_COUNTS, { tokens: true, 'output-cap': true, 'output-echo': true, 'output-offset': true, flips: false })
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
  assert.deepEqual(verdictOf(recorded, 'SAME'), { verdict: 'SAME', flaggedBy: [], passedBy: ['output-cap', 'kbf'], undecidedConfirmation: null })
  // A pre-check with no result the table does not count: it blocks nothing.
  const open = evidenceOf({ tokenizerPrecheck: precheck('inconclusive'), outputCap: cap('pass') })
  assert.deepEqual(verdictOf(readingsOfEvidence(open, 'SAME'), 'SAME').openTests, ['tokens'], 'counted, it keeps the seller from SAME')
  assert.equal(verdictOf(readingsOfEvidence(open, 'SAME', off), 'SAME').verdict, 'SAME')
  assert.deepEqual(inactiveChecks(open, off).find((entry) => entry.check === 'tokens'),
    { check: 'tokens', cause: 'rule', reason: 'the token-count pre-check is recorded only for now: the audit rules do not count it toward the verdict' })
  // A pass it does not count is no pass either.
  const passed = evidenceOf({ tokenizerPrecheck: precheck('match'), outputCap: cap('pass') })
  assert.deepEqual(verdictOf(readingsOfEvidence(passed, 'SAME', off), 'SAME').passedBy, ['output-cap', 'kbf'])
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
    assert.notEqual(verifierRulesHash({ testCounts: { ...AUDIT_TEST_COUNTS, [id]: !AUDIT_TEST_COUNTS[id] } }), pinned, id)
  }
})
