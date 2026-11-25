import assert from 'node:assert/strict'
import test from 'node:test'
import { THINKING_LEVELS, computeReferenceId, type KbfReferenceV1 } from '@antseed/fingerprints'
import { AUDITED_MODELS } from './audited-models.js'
import { AUDIT_THINKING, auditThinkingFor, auditThinkingForBank } from './audit-thinking-table.js'
import { askedAsReference, bankSetting, requestCarries, resolveThinking, strategySetting, type TestThinking } from './audit-thinking.js'
import { assertBankFollowsThinkingTable } from './probe-bank.js'
import { referenceFixture } from './model-audit-fixtures.test-support.js'
import { verifierRulesHash } from './verifier-compat.js'

const MODEL = 'deepseek-v4-pro'

/** A bank asked on OpenRouter with a provider pin (the table applies), recorded with `strategy`. */
function pinnedBank(model: string, strategy: string, overrides: Record<string, unknown>): KbfReferenceV1 {
  const bank: KbfReferenceV1 = structuredClone(referenceFixture(model))
  bank.generator.params = {
    ...bank.generator.params,
    referenceEndpointRequest: { reasoningStrategy: strategy, requestOverrides: overrides, requestOmissions: [] },
    referenceProvider: { pinned: { order: ['example-host'], allowFallbacks: false }, served: ['Example Host'] },
  }
  bank.referenceId = computeReferenceId(bank)
  return bank
}
const own: TestThinking = { needs: { seller: 'own', reference: 'bank', crowd: 'reference' }, why: 'a test' }

test('every audited model has an entry, and the table names no other model', () => {
  assert.deepEqual(Object.keys(AUDIT_THINKING).sort(), Object.keys(AUDITED_MODELS).sort())
  for (const [model, entry] of Object.entries(AUDIT_THINKING)) {
    assert.ok(THINKING_LEVELS.includes(entry.level), model)
    assert.ok(entry.fallback === null || (THINKING_LEVELS.includes(entry.fallback) && entry.fallback !== entry.level), model)
    // `none` is never a fallback: a model that refuses its level is asked to think a little, never told to stop.
    assert.notEqual(entry.fallback, 'none', model)
  }
  assert.deepEqual(auditThinkingFor('Gemini-4-Neon'), { level: 'low', fallback: 'minimal' })
  assert.equal(auditThinkingFor('example-model'), undefined)
})

test('the table applies to a bank asked on OpenRouter with a provider pin, not to one asked on a maker\'s own API', () => {
  assert.deepEqual(auditThinkingForBank(MODEL, pinnedBank(MODEL, 'reasoning-effort-none', { reasoning: { effort: 'none' } })), { level: 'none', fallback: 'minimal' })
  const nativeBank = structuredClone(referenceFixture(MODEL))
  nativeBank.generator.params = { ...nativeBank.generator.params, referenceProvider: { pinned: null, served: [] } }
  assert.equal(auditThinkingForBank(MODEL, nativeBank), undefined)
  assert.equal(auditThinkingForBank(MODEL, referenceFixture(MODEL)), undefined)
})

test('each side gets the level in its own field: the reference OpenRouter\'s, every seller and the crowd Chat Completions\'', () => {
  const bank = pinnedBank(MODEL, 'reasoning-effort-none', { reasoning: { effort: 'none' } })
  // A seller whose check did not answer is still asked with the table's level, in Chat Completions' field.
  const resolved = resolveThinking(own, { model: MODEL, bank, discovery: null })
  assert.deepEqual(resolved.seller.overrides, { reasoning_effort: 'none' })
  assert.deepEqual(resolved.reference.overrides, { reasoning: { effort: 'none' } })
  assert.deepEqual(resolved.crowd?.overrides, { reasoning_effort: 'none' })
  // The seller's check decides between level and fallback; a refusal gave the fallback.
  const refused = resolveThinking(own, { model: MODEL, bank, discovery: { strategy: 'chat-reasoning-effort-minimal' } })
  assert.deepEqual(refused.seller.overrides, { reasoning_effort: 'minimal' })
  // The same level in the two fields is asked the reference's way; another level is not.
  assert.equal(askedAsReference(resolved.seller, bankSetting(bank)), true)
  assert.equal(askedAsReference(strategySetting('chat-reasoning-effort-low'), bankSetting(bank)), false)
  // A bank asked on a maker's own API keeps the bank's setting, as before.
  const plain = resolveThinking(own, { model: MODEL, bank: referenceFixture(MODEL), discovery: null })
  assert.equal(plain.seller.source, 'bank')
})

test('a seller\'s signed request carries the level in Chat Completions\' field, or in Responses\' to which the proxy translates it, and nothing else', () => {
  const setting = strategySetting('chat-reasoning-effort-low')
  const messages = [{ role: 'user', content: 'q' }]
  assert.equal(requestCarries({ messages, reasoning_effort: 'low' }, setting), true)
  assert.equal(requestCarries({ input: messages, reasoning: { effort: 'low' } }, setting), true)
  // Dropped in translation (Anthropic Messages), another level, or another thinking field beside it: not carried.
  assert.equal(requestCarries({ messages }, setting), false)
  assert.equal(requestCarries({ messages, reasoning_effort: 'minimal' }, setting), false)
  assert.equal(requestCarries({ messages, reasoning_effort: 'low', thinking: { type: 'disabled' } }, setting), false)
  assert.equal(requestCarries({ messages, reasoning: { effort: 'low', max_tokens: 9000 } }, setting), false)
})

test('a bank asked with neither the table\'s level nor its fallback is rebuilt', () => {
  const asBank = (bank: KbfReferenceV1) => ({ queryProfile: bank.queryProfile, referenceTemplate: { generator: bank.generator } })
  // Gemini 4 Neon: `low`, or `minimal` where refused. Discovery chose `disable-thinking` on one auditor in dry run 5.
  assert.doesNotThrow(() => assertBankFollowsThinkingTable(asBank(pinnedBank('gemini-4-neon', 'reasoning-effort-low', { reasoning: { effort: 'low' } })), 'gemini-4-neon'))
  assert.doesNotThrow(() => assertBankFollowsThinkingTable(asBank(pinnedBank('gemini-4-neon', 'reasoning-effort-minimal', { reasoning: { effort: 'minimal' } })), 'gemini-4-neon'))
  assert.throws(
    () => assertBankFollowsThinkingTable(asBank(pinnedBank('gemini-4-neon', 'disable-thinking', { thinking: { type: 'disabled' } })), 'gemini-4-neon'),
    /asked with thinking setting 'disable-thinking'; the audit rules ask for 'low' \(or 'minimal' where refused\): archive it and rebuild/,
  )
  // A bank asked on a maker's own API is not checked.
  assert.doesNotThrow(() => assertBankFollowsThinkingTable(asBank(referenceFixture('gemini-4-neon')), 'gemini-4-neon'))
})

test('the table is part of the audit rules: changing an entry changes the rules hash', () => {
  const changed = { ...AUDIT_THINKING, 'gemini-4-neon': { level: 'minimal' as const, fallback: 'low' as const } }
  assert.notEqual(verifierRulesHash({ thinkingTable: changed }), verifierRulesHash())
  assert.equal(verifierRulesHash({ thinkingTable: AUDIT_THINKING }), verifierRulesHash())
})
