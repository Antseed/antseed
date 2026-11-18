import assert from 'node:assert/strict'
import test from 'node:test'
import { KBF_CALIBRATION_PASSES, KBF_DEFAULT_SELF_TEST_RUNS } from '@antseed/fingerprints'
import { PROBE_GUARD_RANGES, isSafeProbe } from '@antseed/node/payments'
import { AUDITED_MODELS } from './audited-models.js'
import { DEFAULT_LAYOUT_FILTER_PASSES } from './model-reference.js'
import {
  DEFAULT_REFERENCE_MAXIMUM_PROBE_COUNT,
  DEFAULT_REFERENCE_MINIMUM_PROBE_COUNT,
  DEFAULT_REFERENCE_MINIMUM_STATISTICAL_POWER,
  DEFAULT_REFERENCE_PROBE_STEP,
} from './reference-sizing.js'
import { DIFF_HOLD_EPOCHS } from './diff-hold.js'
import { VERIFIER_COMPAT, readCompat, verifierRuleOverrides, verifierRulesFingerprint, verifierRulesHash } from './verifier-compat.js'

/**
 * The audit rules each verifier compat number stands for. When this test fails, the change alters how
 * auditors split models or judge sellers: bump `antseedVerifier.compat` in apps/cli/package.json, add
 * the new hash here, and release it at the end of an epoch so every auditor switches at the same
 * epoch start. Never edit an existing entry.
 */
const RULES_BY_COMPAT: Readonly<Record<number, string>> = {
  1: '0x6f6ad26fc799721018d248d22fba70ba99db7a80e9d7fdfaab6c281f242816c3',
  2: '0x9e4b0af7ac00fed169980914711f6f73bb3f0e73547627b3ce0df0f191111ddf',
  3: '0x25344c731acc4781b8f3d207794922f1596a7bf842958ea91111fd575aa7a1e5',
  4: '0xc0ebca1ce20148076c6ed5db82d89e1b28c2fc87aa3fd02ba20899150e1b8a0b',
  5: '0x997f124539dadf245bb8eee8c3b437df9a945e9842ed9f95daa0832e18acb7d9',
  6: '0x9e63b7f3691b9dad3bef95f4a1acccd07f5831268bd88003ae8e0d21d3d0f976',
}

test('the audit rules match the hash pinned for this verifier compat', () => {
  assert.equal(
    verifierRulesHash(),
    RULES_BY_COMPAT[VERIFIER_COMPAT],
    `the audit rules changed: bump antseedVerifier.compat in apps/cli/package.json to ${VERIFIER_COMPAT + 1} `
    + `and pin ${VERIFIER_COMPAT + 1}: '${verifierRulesHash()}' in verifier-compat.test.ts`,
  )
})

test('the fingerprint is stable across calls', () => {
  assert.equal(verifierRulesHash(), verifierRulesHash())
})

test('a change to the audited models without a compat bump no longer matches the pinned hash', () => {
  const pinned = RULES_BY_COMPAT[VERIFIER_COMPAT]
  const [firstKey, first] = Object.entries(AUDITED_MODELS)[0]!
  const { [firstKey]: _dropped, ...withoutFirst } = AUDITED_MODELS
  const changes = {
    'a model dropped': withoutFirst,
    'a model added': { ...AUDITED_MODELS, 'zz-new-model': { ...first, upstreamModel: 'zz/new-model' } },
    'a contrast swapped': { ...AUDITED_MODELS, [firstKey]: { ...first, contrastModels: ['zz/other-contrast', ...first.contrastModels.slice(1)] } },
    'an upstream id changed': { ...AUDITED_MODELS, [firstKey]: { ...first, upstreamModel: `${first.upstreamModel}-2` } },
  }
  for (const [change, auditedModels] of Object.entries(changes)) {
    assert.notEqual(verifierRulesHash({ auditedModels }), pinned, change)
  }
  // Order in the source does not matter: the same models in reverse give the same hash.
  assert.equal(verifierRulesHash({ auditedModels: Object.fromEntries(Object.entries(AUDITED_MODELS).reverse()) }), pinned)
})

test('the fingerprint covers the tolerance table, prompts, parsing, scoring and the settings auditors must share', () => {
  const fingerprint = verifierRulesFingerprint() as {
    domains: Array<{ key: string; tolerance: unknown }>
    parsed: Array<Array<number | null>>
    scored: Array<0 | 1 | null>
    calibration: { passes: number }
    reference: { layoutFilterPasses: number }
    kbf: { promptVariantsHash: string; closeCallExtensions: number; selfTestRuns: number }
  }
  assert.ok(fingerprint.domains.some((domain) => domain.key === 'physics'))
  assert.match(fingerprint.kbf.promptVariantsHash, /^sha256:/)
  assert.ok(fingerprint.parsed.some((answers) => answers.includes(-78.5)), 'a Unicode minus is read as a sign')
  assert.ok(fingerprint.parsed.some((answers) => answers.join() === '3.14,2.71'), 'decimals are not read as labels')
  assert.deepEqual([...new Set(fingerprint.scored)].sort(), [0, 1, null].sort())
  assert.equal(fingerprint.calibration.passes, KBF_CALIBRATION_PASSES)
  assert.equal(fingerprint.reference.layoutFilterPasses, DEFAULT_LAYOUT_FILTER_PASSES)
  assert.equal(fingerprint.kbf.closeCallExtensions, 2)
  assert.equal(fingerprint.kbf.selfTestRuns, KBF_DEFAULT_SELF_TEST_RUNS)
})

test('config that changes the audit rules is named; the pinned values and unset settings are not', () => {
  assert.deepEqual(verifierRuleOverrides(undefined), [])
  assert.deepEqual(verifierRuleOverrides({ closeCallExtensions: 2, referenceSelfTestRuns: KBF_DEFAULT_SELF_TEST_RUNS }), [])
  const overrides = verifierRuleOverrides({ closeCallExtensions: 1, referenceSelfTestRuns: 5, referenceLayoutFilterPasses: 1 })
  assert.equal(overrides.length, 3)
  assert.match(overrides[1]!, /referenceSelfTestRuns is 5/)
})

test('a DIFF hold set away from the pinned one is named; the default is not', () => {
  assert.deepEqual(verifierRuleOverrides({ diffHoldEpochs: DIFF_HOLD_EPOCHS }), [])
  assert.deepEqual(verifierRuleOverrides({ diffHoldEpochs: 0 }), ['verifier.diffHoldEpochs is 0; these rules use 1'])
  // A DIFF from epoch 10 holds epoch 11 only; a SAME never holds.
  const { window } = verifierRulesFingerprint() as { window: { diffHoldEpochs: number; diffHold: boolean[][]; diffHoldResults: boolean[] } }
  assert.equal(window.diffHoldEpochs, 1)
  assert.deepEqual(window.diffHold, [[false, false], [true, false], [false, false], [false, false]])
  // In epoch 11 a SAME and an UNDETERMINED are held; a repeat DIFF is sent.
  assert.deepEqual(window.diffHoldResults, [true, false, true])
})

test('the tokenizer pre-check is part of the rules: turned off it is named, and the fingerprint has its rule and judgements', () => {
  assert.deepEqual(verifierRuleOverrides({ tokenizerPrecheck: true }), [])
  assert.deepEqual(verifierRuleOverrides({ tokenizerPrecheck: false }), ['verifier.tokenizerPrecheck is false; these rules use true'])
  const { tokenizerPrecheck } = verifierRulesFingerprint() as {
    tokenizerPrecheck: {
      rule: { id: string; rounds: number; toleranceTokens: number; referenceAsks: number; sellerAsks: number; outvoteSellers: number; corroboratingSellers: number }
      referenceProbeTries: number
      sellerRequestTries: number
      probeGuardRanges: Array<[number, number]>
      probes: Array<{ a: string; b: string }>
      judged: string[]
      referenceDeltas: Array<number | null>
      crowds: Array<[boolean, boolean, boolean]>
      guarded: boolean[]
      signedUsage: Array<{ inputTokens: number | null; cachedInput: boolean }>
    }
  }
  const { rule } = tokenizerPrecheck
  assert.deepEqual(
    [rule.id, rule.rounds, rule.toleranceTokens, rule.referenceAsks, rule.sellerAsks, rule.outvoteSellers, rule.corroboratingSellers],
    ['tokenizer-precheck-v1', 3, 2, 2, 2, 2, 1],
  )
  // The retry limits, the probe guard's table and what the probe writer writes are rules too: a change to any of
  // them changes which counts are compared.
  assert.deepEqual([tokenizerPrecheck.referenceProbeTries, tokenizerPrecheck.sellerRequestTries], [3, 2])
  assert.deepEqual(tokenizerPrecheck.probeGuardRanges, PROBE_GUARD_RANGES)
  assert.equal(tokenizerPrecheck.probes.length, 4)
  assert.equal(new Set(tokenizerPrecheck.probes.map((probe) => probe.a + probe.b)).size, 4)
  for (const probe of tokenizerPrecheck.probes) assert.ok(isSafeProbe(probe.b), probe.b)
  assert.deepEqual(tokenizerPrecheck.probes, (verifierRulesFingerprint() as { tokenizerPrecheck: { probes: unknown } }).tokenizerPrecheck.probes, 'the same probes every time')
  // Within the tolerance once is a match, cached or not; a mismatch is three rounds off, each the same way twice;
  // anything missing, a seller whose two asks disagree, and a count that is off with the cache in play decide nothing.
  assert.deepEqual(tokenizerPrecheck.judged, [
    'match', 'match', 'mismatch', 'match', 'inconclusive', 'inconclusive', 'inconclusive', 'inconclusive', 'inconclusive',
    'match', 'inconclusive',
  ])
  // A reference with cached input or from two providers has no difference; one that names no provider has.
  assert.deepEqual(tokenizerPrecheck.referenceDeltas, [117, null, null, null, null, null, null, 117])
  // For each crowd: whether a seller signs the reference's count, whether the sellers outvote the reference (a
  // group of two or more on one other count, larger than the group on the reference's), and whether a seller
  // off in every round is then a mismatch: only when the reference is backed and not outvoted.
  assert.deepEqual(tokenizerPrecheck.crowds, [
    [true, true, false], [true, false, true], [true, false, true], [false, true, false],
    [true, false, true], [false, false, false], [true, false, true], [false, false, false],
    [true, true, false],
  ])
  assert.deepEqual(tokenizerPrecheck.guarded, [true, true, true, false, false, false, false, false])
  // The last four: cached input without a count, a body cut off before its end, an event-stream line, an error
  // sent with status 200.
  assert.deepEqual(tokenizerPrecheck.signedUsage.map((usage) => usage.inputTokens), [143, 16, 12, null, null, null, 120, 802, null, null, null, null, null])
  assert.deepEqual(tokenizerPrecheck.signedUsage.map((usage) => usage.cachedInput), [false, true, true, false, false, false, true, true, false, true, false, false, false])
})

test('question set sizing set away from the pinned rules is named; the defaults are not', () => {
  assert.deepEqual(verifierRuleOverrides({
    referenceMinimumProbeCount: DEFAULT_REFERENCE_MINIMUM_PROBE_COUNT,
    referenceMaximumProbeCount: DEFAULT_REFERENCE_MAXIMUM_PROBE_COUNT,
    referenceProbeStep: DEFAULT_REFERENCE_PROBE_STEP,
    referenceMinimumStatisticalPower: DEFAULT_REFERENCE_MINIMUM_STATISTICAL_POWER,
  }), [])
  const overrides = verifierRuleOverrides({
    referenceMinimumProbeCount: 50,
    referenceMaximumProbeCount: 200,
    referenceProbeStep: 5,
    referenceMinimumStatisticalPower: 0.1,
  })
  assert.equal(overrides.length, 4)
  assert.match(overrides.join('; '), /referenceMinimumProbeCount is 50/)
  assert.match(overrides.join('; '), /referenceMaximumProbeCount is 200/)
  assert.match(overrides.join('; '), /referenceProbeStep is 5/)
  assert.match(overrides.join('; '), /referenceMinimumStatisticalPower is 0\.1; these rules use 0\.9/)
})

test('a bumped compat without a pinned hash fails', () => {
  assert.equal(RULES_BY_COMPAT[VERIFIER_COMPAT + 1], undefined)
  assert.notEqual(verifierRulesHash(), RULES_BY_COMPAT[VERIFIER_COMPAT + 1])
})

test('a release from before verifier compat counts as 0; a malformed compat is an error', () => {
  assert.equal(readCompat({ version: '0.1.230' }), 0)
  assert.equal(readCompat({ antseedVerifier: { compat: 3 } }), 3)
  assert.throws(() => readCompat({ antseedVerifier: {} }), /invalid antseedVerifier\.compat/)
  assert.throws(() => readCompat({ antseedVerifier: { compat: '2' } }), /invalid antseedVerifier\.compat/)
  assert.throws(() => readCompat({ antseedVerifier: { compat: 1.5 } }), /invalid antseedVerifier\.compat/)
})
