import assert from 'node:assert/strict'
import test from 'node:test'
import { KBF_CALIBRATION_PASSES, KBF_DEFAULT_SELF_TEST_RUNS } from '@antseed/fingerprints'
import { AUDITED_MODELS } from './audited-models.js'
import { DEFAULT_LAYOUT_FILTER_PASSES } from './model-reference.js'
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
