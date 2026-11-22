import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkLabel, flagInReport, testsInRunLine,
  type AuditCheckId, type CheckSlot, type CheckSummaries, type ListedCheck,
} from './audit-checks.js'
import { METHODS } from './methods/index.js'

/**
 * What a test says of one audit to people is part of its description (`RecordCheck.inReport`, `RecordCheck.inRunLine`),
 * and the model report and the run's line take it from the list of tests. The two places differ in their words and
 * in when they speak, and both are pinned here as they are: a test added to the list without an entry below fails,
 * so no test's texts are left to a fallback by oversight.
 */

/** One flagged summary per test, with what the test says of it: per finding in a report, and in the run's line. */
const SAID: { readonly [Slot in CheckSlot]: { summary: CheckSummaries[Slot]; inReport: Partial<Record<AuditCheckId, string | null>>; inRunLine: string | null } } = {
  tokenizerPrecheck: {
    summary: { rule: 'tokenizer-precheck-v3', outcome: 'mismatch', sellerTokens: [193, 176, 176], modelTokens: [141, 130, 145] },
    inReport: { tokens: 'tokenizer pre-check (tokenizer-precheck-v3): signed 193/176/176 input tokens where the model counts 141/130/145' },
    inRunLine: 'tokenizer pre-check: signed 193/176/176 input tokens where the model counts 141/130/145',
  },
  outputCap: {
    summary: {
      rule: 'output-cap-v1', outcome: 'flag', reason: 'over the limit, twice',
      asks: [{ cap: 44, billed: 900, measured: 852, class: 'cap-ignored' }, { cap: 44, billed: 900, measured: null, class: 'cap-ignored' }],
    },
    inReport: { 'output-cap': 'cap check (output-cap-v1): billed 900 on a limit of 44, answer measures 852; asked again, billed 900 on a limit of 44, answer measures ?: the reply limit was ignored' },
    inRunLine: 'cap check: billed 900 on a limit of 44, answer measures 852; asked again, billed 900 on a limit of 44, answer measures ?',
  },
  outputEcho: {
    summary: {
      rule: 'output-echo-v1', outcome: 'flag', flag: 'growth', growth: 'flag', fixedAmount: 'flag',
      reason: 'the seller\'s output grows faster than the model\'s', growths: [[203], [210], [205]], offset: 31,
    },
    // The growth is given with the record's reason; the fixed amount keeps its bare label.
    inReport: { 'output-echo': 'echo check (output-echo-v1): the seller\'s output grows faster than the model\'s', 'output-offset': null },
    inRunLine: 'echo check: the seller\'s output grows faster than the model\'s',
  },
  flips: {
    summary: { rule: 'flips-v2', model: 'deepseek-v4-pro', stage: 'first', outcome: 'flag', counted: true, p: 0.0001, score: 9.1, reason: 'scored 9.10 (p 0.000), below 0.002' },
    // FLIPS keeps its bare label in a report and adds nothing to the run's line.
    inReport: { flips: null },
    inRunLine: null,
  },
}

/** Every slot's flagged summary at once, as one audit's result carries them. */
const flaggedByAll: Partial<CheckSummaries> = Object.fromEntries(Object.entries(SAID).map(([slot, said]) => [slot, said.summary]))

test('every test of the list says what a report and the run\'s line say of it, in the words pinned here', () => {
  const pinned = <Slot extends CheckSlot>(check: ListedCheck<Slot>): void => {
    const said = SAID[check.slot] as (typeof SAID)[Slot] | undefined
    assert.ok(said, `${check.slot} is in the list without its texts pinned here`)
    assert.equal(typeof check.inReport, 'function', `${check.slot} does not say what a report says of it`)
    assert.equal(typeof check.inRunLine, 'function', `${check.slot} does not say what the run's line says of it`)
    // Every finding of the test is pinned, and no finding that is not the test's.
    assert.deepEqual(Object.keys(said.inReport), check.findings.map((finding) => finding.id), check.slot)
    for (const finding of check.findings) {
      assert.equal(check.inReport(finding.id, said.summary), said.inReport[finding.id], finding.id)
    }
    assert.equal(check.inRunLine(said.summary), said.inRunLine, check.slot)
  }
  for (const check of METHODS) pinned(check)
  assert.deepEqual(Object.keys(SAID), METHODS.map((check) => check.slot), 'a slot is pinned here that is not in the list')
})

test('a report names a flagged finding by what its test saw, or by its label where the test gives no more', () => {
  for (const check of METHODS) {
    for (const finding of check.findings) {
      assert.equal(flagInReport(finding.id, flaggedByAll), SAID[check.slot].inReport[finding.id] ?? finding.label, finding.id)
      // A result that holds no summary of the test, or holds it as null, names the finding by its label.
      assert.equal(flagInReport(finding.id, {}), finding.label, finding.id)
      assert.equal(flagInReport(finding.id, { ...flaggedByAll, [check.slot]: null }), finding.label, finding.id)
    }
  }
  assert.equal(flagInReport('output-offset', flaggedByAll), 'the echo check\'s fixed amount')
  assert.equal(flagInReport('flips', flaggedByAll), 'the randomness check')
  // The questions are no test of the list: they are named by their label, their own result follows in the reason.
  assert.equal(flagInReport('kbf', flaggedByAll), checkLabel('kbf'))
})

test('the run\'s line holds each test\'s part in run order, only for a test whose own outcome is a flag', () => {
  assert.deepEqual(testsInRunLine(flaggedByAll), [SAID.tokenizerPrecheck.inRunLine, SAID.outputCap.inRunLine, SAID.outputEcho.inRunLine])
  assert.deepEqual(testsInRunLine({}), [])
  assert.deepEqual(testsInRunLine({ tokenizerPrecheck: null, outputCap: null, outputEcho: null, flips: null } as never), [])
  // A test that passed or did not decide adds nothing.
  assert.deepEqual(testsInRunLine({
    tokenizerPrecheck: { rule: 'tokenizer-precheck-v3', outcome: 'match' },
    outputCap: { ...SAID.outputCap.summary, outcome: 'pass' },
    outputEcho: { ...SAID.outputEcho.summary, outcome: 'inconclusive' },
    flips: { ...SAID.flips.summary, outcome: 'pass' },
  }), [])
  // The echo check speaks on its record's flag, also when only the fixed amount flagged.
  assert.deepEqual(testsInRunLine({ outputEcho: { ...SAID.outputEcho.summary, flag: 'offset', growth: 'pass' } }), [SAID.outputEcho.inRunLine])
  // A pre-check mismatch stored without its counts is still said.
  assert.deepEqual(testsInRunLine({ tokenizerPrecheck: { rule: 'tokenizer-precheck-v3', outcome: 'mismatch' } }), ['tokenizer pre-check: its signed input tokens are not the model\'s'])
})
