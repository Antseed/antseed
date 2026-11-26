import assert from 'node:assert/strict'
import test from 'node:test'
import {
  THINKING_DISCOVERY_MAX_TOKENS,
  THINKING_FALLBACK_MAX_TOKENS,
  ThinkingDiscoveryError,
  discoverThinkingSuppression,
  type ThinkingDiscoveryProbe,
  type ThinkingDiscoveryStrategy,
} from './thinking-suppression.js'

const TEN = Array.from({ length: 10 }, (_unused, index) => `(${index + 1}) ${index + 1}`).join('\n')
const FOUR = Array.from({ length: 4 }, (_unused, index) => `(${index + 1}) ${index + 1}`).join('\n')

function scripted(
  outcomes: Partial<Record<ThinkingDiscoveryStrategy, Awaited<ReturnType<ThinkingDiscoveryProbe>>>>,
  seen: Array<{ strategy: ThinkingDiscoveryStrategy; maxTokens: number }> = [],
): ThinkingDiscoveryProbe {
  return async ({ strategy, maxTokens }) => {
    seen.push({ strategy, maxTokens })
    return outcomes[strategy] ?? { ok: false, status: 400, failure: `${strategy} refused` }
  }
}

test('discovery keeps the first strategy with 5/10 answers and zero reasoning tokens', async () => {
  const seen: Array<{ strategy: ThinkingDiscoveryStrategy; maxTokens: number }> = []
  const result = await discoverThinkingSuppression({
    model: 'm', label: 'u', supportsPrefill: true,
    probe: scripted({
      'reasoning-effort-none': { ok: true, content: TEN, reasoningTokens: 240 },
      'reasoning-effort-minimal': { ok: true, content: FOUR, reasoningTokens: 0 },
      'disable-thinking': { ok: true, content: TEN, reasoningTokens: 0 },
    }, seen),
  })
  assert.equal(result.strategy, 'disable-thinking')
  assert.deepEqual(result.overrides, { thinking: { type: 'disabled' } })
  assert.deepEqual(seen.map((entry) => entry.strategy), ['reasoning-effort-none', 'reasoning-effort-minimal', 'disable-thinking'])
  assert.equal(seen.every((entry) => entry.maxTokens === THINKING_DISCOVERY_MAX_TOKENS), true)
})

test('discovery uses prefill only on Chat Completions and accepts bare even when it thinks', async () => {
  const seen: Array<{ strategy: ThinkingDiscoveryStrategy; maxTokens: number }> = []
  const prefill = await discoverThinkingSuppression({
    model: 'm', label: 'u', supportsPrefill: true,
    probe: scripted({ prefill: { ok: true, content: TEN, reasoningTokens: 0 } }),
  })
  assert.equal(prefill.strategy, 'prefill')
  assert.equal(prefill.assistantPrefill, '<think></think>')
  const bare = await discoverThinkingSuppression({
    model: 'm', label: 'u', supportsPrefill: false,
    probe: scripted({ prefill: { ok: true, content: TEN, reasoningTokens: 0 }, bare: { ok: true, content: TEN, reasoningTokens: 180 } }, seen),
  })
  assert.equal(bare.strategy, 'bare')
  assert.equal(seen.some((entry) => entry.strategy === 'prefill'), false)
})

test('discovery falls back to bare with 50x the tokens, then fails with every attempt', async () => {
  const seen: Array<{ strategy: ThinkingDiscoveryStrategy; maxTokens: number }> = []
  const expanded = await discoverThinkingSuppression({
    model: 'm', label: 'u', supportsPrefill: true,
    probe: scripted({
      bare: { ok: true, content: null, reasoningTokens: 800 },
      'bare-expanded': { ok: true, content: TEN, reasoningTokens: 3000 },
    }, seen),
  })
  assert.equal(expanded.strategy, 'bare-expanded')
  assert.equal(expanded.maxTokens, THINKING_FALLBACK_MAX_TOKENS)
  assert.equal(seen.at(-1)?.maxTokens, THINKING_DISCOVERY_MAX_TOKENS * 50)
  await assert.rejects(discoverThinkingSuppression({
    model: 'm', label: 'u', supportsPrefill: true,
    probe: scripted({ bare: { ok: true, content: FOUR, reasoningTokens: 0 }, 'bare-expanded': { ok: true, content: null, reasoningTokens: 40000 } }),
  }), (error: unknown) => error instanceof ThinkingDiscoveryError && error.attempts.length === 7
    && /no thinking-suppression strategy worked/.test(error.message))
})

test('discovery reports an upstream error when every strategy gets the same HTTP status', async () => {
  await assert.rejects(discoverThinkingSuppression({
    model: 'm', label: 'u', supportsPrefill: true,
    probe: async () => ({ ok: false, status: 404, failure: 'model not found' }),
  }), /refused every request for m with HTTP 404/)
})

test('discovery records reasoning a reply shows and what it bills, and still decides on the reasoning tokens alone', async () => {
  const { billedOutputTokensOf, reasoningShownInReply } = await import('@antseed/fingerprints')
  // A host that sends its reasoning in a field of its own while itemising none.
  const body = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: TEN, reasoning_content: 'Let me think about each question first.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 445, completion_tokens_details: { reasoning_tokens: 0 } },
  })
  assert.equal(reasoningShownInReply(body), true)
  assert.equal(billedOutputTokensOf(body), 445)
  assert.equal(reasoningShownInReply(JSON.stringify({ choices: [{ message: { content: TEN, reasoning_content: '  ' } }] })), false, 'blank is no reasoning')
  assert.equal(reasoningShownInReply('not json'), false)
  assert.equal(billedOutputTokensOf(JSON.stringify({ usage: { completion_tokens: -1 } })), undefined)
  const result = await discoverThinkingSuppression({
    model: 'glm-5.3', label: 'seller', supportsPrefill: true,
    probe: scripted({ 'reasoning-effort-none': { ok: true, content: TEN, reasoningTokens: 0, reasoningShown: true, billedOutputTokens: 445 } }),
  })
  // Recorded only: the strategy is the one the reasoning tokens give, as before, with the signal kept on its attempt.
  assert.equal(result.strategy, 'reasoning-effort-none')
  assert.deepEqual([result.attempts[0]!.reasoningShown, result.attempts[0]!.billedOutputTokens], [true, 445])
})
