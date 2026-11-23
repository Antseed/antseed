import assert from 'node:assert/strict'
import test from 'node:test'
import { THINKING_DISCOVERY_STRATEGIES, computeReferenceId, kbfTargetThinkingSuppression, thinkingStrategyRequest, type KbfReferenceV1 } from '@antseed/fingerprints'
import type { RecordCheck } from './audit-method.js'
import { QUESTIONS_CHECK, THINKING_DECLARATIONS } from './audit-checks.js'
import {
  NO_THINKING_SETTING, asSuppression, assertRequestCarries, bankReachedZero, bankSetting, isAllowedSetting, isDiscoveryMember, needsSellerDiscovery,
  requestCarries, resolveThinking, strategySetting, type TestThinking, type ThinkingSetting,
} from './audit-thinking.js'
import { METHODS } from './methods/index.js'
import { referenceFixture } from './model-audit-fixtures.test-support.js'

const MODEL = 'deepseek-v4-pro'
/** A bank with no setting of its own (no `referenceEndpointRequest`). */
const PLAIN_BANK = referenceFixture(MODEL)

/** A bank whose discovery recorded `strategy` with `reasoningTokens` on its last attempt of it. */
function bankWith(strategy: string, overrides: Record<string, unknown>, reasoningTokens: number | null, extra: Record<string, unknown> = {}): KbfReferenceV1 {
  const bank: KbfReferenceV1 = structuredClone(PLAIN_BANK)
  bank.generator.params = {
    ...bank.generator.params,
    referenceEndpointRequest: { reasoningStrategy: strategy, requestOverrides: overrides, requestOmissions: [] },
    thinkingDiscovery: {
      version: 1, method: 'kbf-reference-code-2026-09-30', contrasts: {},
      target: { model: MODEL, strategy, attempts: [{ strategy, maxTokens: 800, status: null, validAnswers: 10, reasoningTokens, answersOnly: true, truncated: false, ...extra }] },
    },
  }
  bank.referenceId = computeReferenceId(bank)
  return bank
}

const FIXED: ThinkingSetting = { source: 'fixed', strategy: null, overrides: { reasoning: { enabled: false } } }
const declared = (needs: TestThinking['needs']): TestThinking => ({ needs, fixed: () => FIXED, why: 'a test' })
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

test('a seller\'s own setting is its discovery\'s, as for its questions, for every strategy discovery can choose', () => {
  for (const strategy of [...THINKING_DISCOVERY_STRATEGIES, 'bare-expanded'] as const) {
    const { seller } = resolveThinking(declared({ seller: 'own', reference: 'bank' }), { model: MODEL, bank: PLAIN_BANK, discovery: { strategy } })
    const request = thinkingStrategyRequest(strategy)
    assert.deepEqual(seller.overrides, request.overrides, strategy)
    assert.equal(seller.assistantPrefill, request.assistantPrefill, strategy)
    assert.equal(seller.source, 'discovery')
    // The token budget of `bare-expanded` is the questions' own, never part of a setting.
    assert.equal('maxTokens' in seller, false)
  }
})

test('a seller with no discovery, or one that failed, is sent the bank\'s setting, as its questions are', () => {
  const bank = bankWith('reasoning-effort-none', { reasoning: { effort: 'none' }, provider: { order: ['maker'] } }, 0)
  for (const discovery of [null, { strategy: null }]) {
    const { seller } = resolveThinking(declared({ seller: 'own', reference: 'bank' }), { model: MODEL, bank, discovery })
    // Only the thinking fields: the bank's other endpoint quirks never reach a seller.
    assert.deepEqual(seller, { source: 'bank', strategy: 'reasoning-effort-none', overrides: { reasoning: { effort: 'none' } } })
    assert.deepEqual(asSuppression(seller), kbfTargetThinkingSuppression(bank))
  }
  // A bank with no setting gives none, and the builders then send exactly what they always sent.
  const { seller } = resolveThinking(declared({ seller: 'own', reference: 'bank' }), { model: MODEL, bank: PLAIN_BANK, discovery: null })
  assert.equal(asSuppression(seller), null)
  assert.equal(kbfTargetThinkingSuppression(PLAIN_BANK), null)
})

test('`bare` sends nothing, `fixed` sends the test\'s own body, and the crowd follows its declaration', () => {
  const discovery = { strategy: 'reasoning-effort-none' as const }
  const bank = bankWith('reasoning-effort-minimal', { reasoning: { effort: 'minimal' } }, 0)
  const bare = resolveThinking(declared({ seller: 'bare', reference: 'bank', crowd: 'bare' }), { model: MODEL, bank, discovery })
  assert.deepEqual([bare.seller, bare.crowd], [NO_THINKING_SETTING, NO_THINKING_SETTING])
  const fixed = resolveThinking(declared({ seller: 'fixed', reference: 'fixed' }), { model: MODEL, bank, discovery })
  assert.deepEqual([fixed.seller, fixed.reference, fixed.crowd], [FIXED, FIXED, null])
  const crowd = resolveThinking(declared({ seller: 'own', reference: 'bank', crowd: 'reference' }), { model: MODEL, bank, discovery })
  assert.deepEqual(crowd.crowd, bankSetting(bank))
  assert.throws(() => resolveThinking({ needs: { seller: 'fixed', reference: 'bank' }, why: 'no body' }, { model: MODEL, bank, discovery }), /gives none/)
})

test('the reference follows its bank\'s setting where the bank\'s discovery reached 0 reasoning tokens with it, else the test\'s body', () => {
  const ifZero = declared({ seller: 'own', reference: { bank: 'if-zero', otherwise: 'fixed' } })
  const resolve = (bank: KbfReferenceV1) => resolveThinking(ifZero, { model: MODEL, bank, discovery: null }).reference
  const zero = bankWith('reasoning-effort-minimal', { reasoning: { effort: 'minimal' } }, 0)
  assert.equal(bankReachedZero(zero), true)
  assert.deepEqual(resolve(zero), bankSetting(zero))
  // A bank whose setting still thinks (DeepSeek's `bare`), one whose reply was not clean, and one with no stored discovery.
  for (const bank of [
    bankWith('bare', {}, 574),
    bankWith('reasoning-effort-none', { reasoning: { effort: 'none' } }, 0, { answersOnly: false }),
    bankWith('reasoning-effort-none', { reasoning: { effort: 'none' } }, 0, { validAnswers: 4 }),
    PLAIN_BANK,
  ]) {
    assert.equal(bankReachedZero(bank), false)
    assert.deepEqual(resolve(bank), FIXED)
  }
})

test('a request carries a setting only with exactly its fields and its prefill', () => {
  const none = strategySetting('reasoning-effort-none')
  const prefill = strategySetting('prefill')
  const chat = { model: 'm', messages: [{ role: 'user', content: 'q' }], max_tokens: 9 }
  assert.equal(requestCarries({ ...chat, reasoning: { effort: 'none' } }, none), true)
  assert.equal(requestCarries(chat, none), false)
  assert.equal(requestCarries({ ...chat, reasoning: { effort: 'minimal' } }, none), false)
  // Another thinking member beside the setting's is not the setting.
  assert.equal(requestCarries({ ...chat, reasoning: { effort: 'none' }, thinking: { type: 'disabled' } }, none), false)
  assert.equal(requestCarries({ ...chat, reasoning: { effort: 'none' } }, NO_THINKING_SETTING), false)
  assert.equal(requestCarries(chat, NO_THINKING_SETTING), true)
  // The prefill is the last turn, in Chat and in the Responses shape the proxy may translate to.
  const prefilled = { ...chat, messages: [...chat.messages, { role: 'assistant', content: '<think></think>' }] }
  assert.equal(requestCarries(prefilled, prefill), true)
  assert.equal(requestCarries(prefilled, NO_THINKING_SETTING), false)
  assert.equal(requestCarries(chat, prefill), false)
  assert.equal(requestCarries({ model: 'm', input: [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'output_text', text: '<think></think>' }] }] }, prefill), true)
  assert.doesNotThrow(() => assertRequestCarries(bytes({ ...chat, reasoning: { effort: 'none' } }), none, 'a request'))
  assert.throws(() => assertRequestCarries(bytes(chat), none, 'a seller request'), /a seller request does not carry the thinking setting its record names/)
  assert.throws(() => assertRequestCarries('not json', none, 'a request'), /does not carry/)
})

test('a stored setting is one its side may name, and nothing else', () => {
  const all = { discovery: true, bank: true, none: true, fixed: FIXED }
  for (const strategy of THINKING_DISCOVERY_STRATEGIES) assert.equal(isAllowedSetting(strategySetting(strategy), all), true, strategy)
  assert.equal(isAllowedSetting(strategySetting('reasoning-effort-none'), { bank: true }), false)
  // A strategy's name with other fields than its own.
  assert.equal(isAllowedSetting({ ...strategySetting('reasoning-effort-none'), overrides: { reasoning: { effort: 'low' } } }, all), false)
  assert.equal(isAllowedSetting({ source: 'discovery', strategy: 'reasoning-effort-low', overrides: { reasoning: { effort: 'low' } } }, all), false)
  // The bank's: thinking members only.
  assert.equal(isAllowedSetting({ source: 'bank', strategy: 'reasoning-effort-none', overrides: { reasoning: { effort: 'none' } } }, all), true)
  assert.equal(isAllowedSetting({ source: 'bank', strategy: null, overrides: { tools: [] } }, all), false)
  assert.equal(isAllowedSetting({ ...FIXED, overrides: { reasoning: { effort: 'minimal' } } }, all), false)
  assert.equal(isAllowedSetting(FIXED, all), true)
  assert.equal(isAllowedSetting({ ...strategySetting('prefill'), assistantPrefill: 'hello' }, all), false)
  assert.equal(isAllowedSetting(null, all), false)
})

test('a question batch may carry exactly the settings discovery chooses from, as before', () => {
  for (const strategy of THINKING_DISCOVERY_STRATEGIES) {
    for (const [member, value] of Object.entries(thinkingStrategyRequest(strategy).overrides)) assert.equal(isDiscoveryMember(member, value), true, strategy)
  }
  // FLIPS's eval table holds two switches discovery never tries: a question batch never carries them.
  assert.equal(isDiscoveryMember('reasoning', { enabled: false }), false)
  assert.equal(isDiscoveryMember('reasoning', { effort: 'low' }), false)
  assert.equal(isDiscoveryMember('tools', []), false)
})

test('every test declares its thinking need, in one list with the questions first; none before the questions needs the seller\'s own', () => {
  assert.deepEqual(THINKING_DECLARATIONS.map((entry) => entry.test), [QUESTIONS_CHECK.id, ...METHODS.map((check) => check.slot)])
  assert.deepEqual(QUESTIONS_CHECK.thinking.needs, { seller: 'own', reference: 'bank' })
  for (const check of METHODS) {
    assert.ok(check.thinking.why.length > 0, check.slot)
    if (check.phase === 'before-questions') assert.equal(needsSellerDiscovery(check.thinking), false, check.slot)
    if (check.thinking.needs.seller === 'fixed' || check.thinking.needs.reference !== 'bank') assert.ok(check.thinking.fixed, check.slot)
  }
  // The compiler holds both: a test without a declaration, and a before-questions test that needs the seller's own.
  const body = METHODS[0] as unknown as RecordCheck<'tokenizerPrecheck'>
  // @ts-expect-error a test must declare its thinking need
  const undeclared: RecordCheck<'tokenizerPrecheck'> = { ...body, thinking: undefined }
  // @ts-expect-error a test asked before the questions is asked before discovery
  const tooEarly: RecordCheck<'tokenizerPrecheck'> = { ...body, phase: 'before-questions', thinking: { needs: { seller: 'own', reference: 'bank' }, why: 'x' } }
  assert.ok(undeclared && tooEarly)
})
