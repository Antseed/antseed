import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import type { RecordCheck } from './audit-checks.js'
import { METHODS } from './methods/index.js'
import { TOKENS_CHECK } from './methods/tokens/method.js'
import { verifierRuleOverrides, verifierRulesFingerprint } from './verifier-compat.js'

/**
 * The rules fingerprint takes each test's part from the list of tests: the test's own block (`RecordCheck.fingerprint`)
 * under its slot's name, and its switch with the value the compat number stands for (`RecordCheck.toggle`). A test
 * added to the list is then under the pinned hash without an edit to the fingerprint, and one without a block is
 * stopped here or by the compiler. The pinned hash itself is `verifier-compat.test.ts`'s.
 */

/** What the fingerprint holds under a test's slot beside the test's own block: the samples of rules that cross tests. */
const CROSS_TEST_SAMPLES: Readonly<Record<string, readonly string[]>> = {
  flips: ['auditorFailure', 'oneAttemptStop', 'stageBound'],
}

test('every test of the list gives its own block of the rules fingerprint, the same one every time', () => {
  for (const check of METHODS) {
    assert.equal(typeof check.fingerprint, 'function', `${check.slot} has no block of the rules fingerprint`)
    const block = check.fingerprint()
    assert.ok(block !== null && typeof block === 'object' && !Array.isArray(block), `${check.slot}'s block is not an object`)
    // A block starts with the rule new audits are judged by: a new rule id is a new hash.
    assert.equal(typeof (block['rule'] as { id?: unknown } | undefined)?.id, 'string', `${check.slot}'s block does not name its rule`)
    // Nothing in it is drawn at random or read from the clock.
    assert.equal(canonicalJsonStringify(check.fingerprint()), canonicalJsonStringify(block), check.slot)
  }
})

test('each test\'s block is in the rules fingerprint under the test\'s slot, with only the samples of rules that cross tests beside it', () => {
  const fingerprint = verifierRulesFingerprint() as Record<string, Record<string, unknown> | undefined>
  assert.equal(new Set(METHODS.map((check) => check.slot)).size, METHODS.length, 'two tests share a slot')
  for (const check of METHODS) {
    const block = check.fingerprint()
    const held = fingerprint[check.slot]
    assert.ok(held, `the rules fingerprint has no ${check.slot}`)
    // No key of the test's block is replaced, and nothing else is held under its name.
    assert.deepEqual(Object.keys(held).sort(), [...Object.keys(block), ...(CROSS_TEST_SAMPLES[check.slot] ?? [])].sort(), check.slot)
    for (const key of Object.keys(block)) {
      assert.equal(canonicalJsonStringify(held[key]), canonicalJsonStringify(block[key]), `${check.slot}.${key}`)
    }
  }
})

test('a test\'s switch set away from the value the compat number stands for is named: once per switch, in the list\'s order', () => {
  const switches = [...new Map(METHODS.map((check) => [check.toggle.key, check.toggle.pinned] as const))]
  assert.deepEqual(switches, [['tokenizerPrecheck', true], ['outputChecks', true], ['flips', true]])
  // Tests behind one switch stand for one value of it.
  for (const check of METHODS) assert.equal(check.toggle.pinned, new Map(switches).get(check.toggle.key), check.slot)
  for (const [key, pinned] of switches) {
    assert.deepEqual(verifierRuleOverrides({ [key]: pinned }), [], key)
    assert.deepEqual(verifierRuleOverrides({ [key]: !pinned }), [`verifier.${key} is ${!pinned}; these rules use ${pinned}`], key)
  }
  // Among the other pinned settings they stand where they have always been named.
  assert.deepEqual(
    verifierRuleOverrides({
      closeCallExtensions: 1, diffHoldEpochs: 0, tokenizerPrecheck: false, outputChecks: false, flips: false, referenceSelfTestRuns: 5,
    }).map((line) => line.split(' ')[0]),
    ['verifier.closeCallExtensions', 'verifier.diffHoldEpochs', 'verifier.tokenizerPrecheck', 'verifier.outputChecks', 'verifier.flips', 'verifier.referenceSelfTestRuns'],
  )
})

test('a description without its block, or without its switch\'s pinned value, is no entry of the list', () => {
  // Each line below must stay a type error: were `fingerprint` or `toggle.pinned` optional, a new test could be listed
  // without them, and this file would stop compiling on the unused directive.
  const { fingerprint: _block, ...withoutBlock } = TOKENS_CHECK
  // @ts-expect-error a test of the list gives its block of the rules fingerprint
  const noBlock: RecordCheck<'tokenizerPrecheck'> = withoutBlock
  // @ts-expect-error and the value of its switch the compat number stands for
  const noPinned: RecordCheck<'tokenizerPrecheck'> = { ...TOKENS_CHECK, toggle: { key: TOKENS_CHECK.toggle.key } }
  assert.equal('fingerprint' in noBlock, false)
  assert.equal('pinned' in noPinned.toggle, false)
})
