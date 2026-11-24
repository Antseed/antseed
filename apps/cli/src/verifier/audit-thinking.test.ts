import assert from 'node:assert/strict'
import test from 'node:test'
import { THINKING_DISCOVERY_STRATEGIES, computeReferenceId, kbfTargetThinkingSuppression, thinkingStrategyRequest, type KbfReferenceV1 } from '@antseed/fingerprints'
import type { RecordCheck } from './audit-method.js'
import { QUESTIONS_CHECK, THINKING_DECLARATIONS } from './audit-checks.js'
import {
  NO_THINKING_SETTING, asSuppression, assertRequestCarries, bankReachedZero, bankSetting, isAllowedSetting, isDiscoveryMember, needsSellerDiscovery,
  askedAsReference, referenceDiscoveryStrategy, requestCarries, resolveThinking, sameRequestSetting, strategySetting, type TestThinking, type ThinkingSetting,
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
  // A strategy discovery never sends; "low" it does, as the nearest equivalent of the reference's "minimal".
  assert.equal(isAllowedSetting({ source: 'discovery', strategy: 'reasoning-effort-medium', overrides: { reasoning: { effort: 'medium' } } }, all), false)
  assert.equal(isAllowedSetting(strategySetting('reasoning-effort-low'), all), true)
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
  // The nearest equivalent of the reference's "minimal" may be sent too; FLIPS's other eval switch never is.
  assert.equal(isDiscoveryMember('reasoning', { effort: 'low' }), true)
  assert.equal(isAllowedSetting(strategySetting('reasoning-effort-low'), { discovery: true }), true)
  assert.equal(isDiscoveryMember('reasoning', { enabled: false }), false)
  assert.equal(isDiscoveryMember('reasoning', { effort: 'medium' }), false)
  assert.equal(isDiscoveryMember('tools', []), false)
})

test('the reference\'s setting a seller\'s discovery tries first is the strategy its bank\'s discovery chose, and every recheck accepts it', () => {
  const minimal = bankWith('reasoning-effort-minimal', { reasoning: { effort: 'minimal' } }, 0)
  assert.equal(referenceDiscoveryStrategy(minimal), 'reasoning-effort-minimal')
  // Also a least-reasoning pick that still thought: it is what the reference was asked with.
  assert.equal(referenceDiscoveryStrategy(bankWith('reasoning-effort-minimal', { reasoning: { effort: 'minimal' } }, 70)), 'reasoning-effort-minimal')
  assert.equal(referenceDiscoveryStrategy(bankWith('prefill', {}, 0)), 'prefill')
  // None: a bank with no stored discovery, a `bare` or `bare-expanded` bank, an older strategy name, a discovery that is
  // not the request the bank records.
  assert.equal(referenceDiscoveryStrategy(PLAIN_BANK), null)
  assert.equal(referenceDiscoveryStrategy(bankWith('bare', {}, 574)), null)
  assert.equal(referenceDiscoveryStrategy(bankWith('bare-expanded', {}, 3000)), null)
  assert.equal(referenceDiscoveryStrategy(bankWith('reasoning-effort-minimum-supported', { reasoning: { effort: 'low' } }, 0)), null)
  const mismatched = structuredClone(minimal)
  ;(mismatched.generator.params!['thinkingDiscovery'] as { target: { strategy: string } }).target.strategy = 'disable-thinking'
  assert.equal(referenceDiscoveryStrategy(mismatched), null)
  const noDiscovery = structuredClone(minimal)
  delete noDiscovery.generator.params!['thinkingDiscovery']
  assert.equal(referenceDiscoveryStrategy(noDiscovery), null, 'a bank from before discovery was stored')
  // A seller's discovery that kept it: its questions carry it, and the signed-bytes check and the stored-setting check accept it.
  for (const strategy of THINKING_DISCOVERY_STRATEGIES.filter((name) => name !== 'bare')) {
    const setting = resolveThinking(QUESTIONS_CHECK.thinking, { model: MODEL, bank: minimal, discovery: { strategy } }).seller
    for (const [member, value] of Object.entries(setting.overrides)) assert.equal(isDiscoveryMember(member, value), true, strategy)
    assert.equal(isAllowedSetting(setting, { discovery: true }), true, strategy)
  }
  // The same request from discovery and from the bank is the same setting; another one is not.
  assert.equal(sameRequestSetting(strategySetting('reasoning-effort-minimal'), bankSetting(minimal)), true)
  assert.equal(sameRequestSetting(strategySetting('reasoning-effort-none'), bankSetting(minimal)), false)
  assert.equal(sameRequestSetting(strategySetting('prefill'), strategySetting('bare')), false)
})

test('a seller on "low" was asked the way a reference on "minimal" was, from its bank or a fixed body; nothing else is an equivalent', () => {
  const minimal = bankWith('reasoning-effort-minimal', { reasoning: { effort: 'minimal' } }, 0)
  const fixedMinimal: ThinkingSetting = { source: 'fixed', strategy: null, overrides: { reasoning: { effort: 'minimal' } } }
  for (const reference of [bankSetting(minimal), fixedMinimal, strategySetting('reasoning-effort-minimal')]) {
    assert.equal(askedAsReference(strategySetting('reasoning-effort-minimal'), reference), true)
    assert.equal(askedAsReference(strategySetting('reasoning-effort-low'), reference), true)
    assert.equal(askedAsReference(strategySetting('reasoning-effort-none'), reference), false)
  }
  // One way only, and only for "minimal": a seller on "minimal" against a reference on "low", "low" against "none".
  assert.equal(askedAsReference(strategySetting('reasoning-effort-minimal'), { source: 'fixed', strategy: null, overrides: { reasoning: { effort: 'low' } } }), false)
  assert.equal(askedAsReference(strategySetting('reasoning-effort-low'), strategySetting('reasoning-effort-none')), false)
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
