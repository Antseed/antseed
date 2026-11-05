import assert from 'node:assert/strict'
import test from 'node:test'
import { AUDITED_MODELS } from './audited-models.js'
import { VERIFIER_COMPAT, readCompat, verifierRulesHash } from './verifier-compat.js'

/**
 * The audit rules each verifier compat number stands for. When this test fails, the change alters how
 * auditors split models or judge sellers: bump `antseedVerifier.compat` in apps/cli/package.json, add
 * the new hash here, and release it at the end of an epoch so every auditor switches at the same
 * epoch start. Never edit an existing entry.
 */
const RULES_BY_COMPAT: Readonly<Record<number, string>> = {
  1: '0x6f6ad26fc799721018d248d22fba70ba99db7a80e9d7fdfaab6c281f242816c3',
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
