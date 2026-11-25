import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CANDIDATE_WRITING_MAX_TOKENS,
  CANDIDATE_WRITING_THINKING_MAX_TOKENS,
  CandidateWritingPolicy,
  candidateWritingFallback,
  candidateWritingMaxTokens,
  isRamblingCandidateAnswer,
} from './candidate-writing.js'

const openRouter = (overrides: Record<string, unknown>) => ({
  type: 'direct', baseUrl: 'https://openrouter.ai/api/v1', requestOverrides: overrides,
})

test('only an answer that used its tokens and gave under half the facts rambles', () => {
  assert.equal(isRamblingCandidateAnswer({ factCount: 1, requestedCount: 20, outputTokens: 6000, maxTokens: 6000 }), true)
  assert.equal(isRamblingCandidateAnswer({ factCount: 0, requestedCount: 20, outputTokens: 5700, maxTokens: 6000 }), true)
  // Short refusals (Grok), other formats (Sonnet 5) and filtered answers (Fable) are not rambling.
  assert.equal(isRamblingCandidateAnswer({ factCount: 0, requestedCount: 20, outputTokens: 377, maxTokens: 6000 }), false)
  assert.equal(isRamblingCandidateAnswer({ factCount: 3, requestedCount: 20, outputTokens: 824, maxTokens: 6000 }), false)
  // A full list that happens to be long is kept.
  assert.equal(isRamblingCandidateAnswer({ factCount: 10, requestedCount: 20, outputTokens: 6000, maxTokens: 6000 }), false)
})

test('the fallback is a little thinking, only on OpenRouter routes that turn thinking off or set none', () => {
  assert.equal(candidateWritingFallback(openRouter({ reasoning_effort: 'none' })), 'reasoning-effort-minimal')
  assert.equal(candidateWritingFallback(openRouter({ reasoning: { effort: 'none' } })), 'reasoning-effort-minimal')
  // 'bare' (no thinking setting: the model ignored every way to turn it off) can think until no text is left, as GLM 5.3
  // did on every question-writing batch; a little thinking caps it.
  assert.equal(candidateWritingFallback(openRouter({})), 'reasoning-effort-minimal')
  assert.equal(candidateWritingFallback(openRouter({ provider: { order: ['example'] } })), 'reasoning-effort-minimal')
  // A route with another thinking setting keeps it; other APIs and Antseed peers are left alone.
  assert.equal(candidateWritingFallback(openRouter({ reasoning: { effort: 'low', exclude: true } })), null)
  assert.equal(candidateWritingFallback(openRouter({ thinking: { type: 'disabled' } })), null)
  assert.equal(candidateWritingFallback(openRouter({ enable_thinking: false })), null)
  assert.equal(candidateWritingFallback(openRouter({ chat_template_kwargs: { enable_thinking: false } })), null)
  assert.equal(candidateWritingFallback({ ...openRouter({}), assistantPrefill: '<think></think>' }), null)
  assert.equal(candidateWritingFallback({ ...openRouter({}), type: 'antseed' }), null)
  assert.equal(candidateWritingFallback({ ...openRouter({ reasoning_effort: 'none' }), assistantPrefill: '<think></think>' }), null)
  assert.equal(candidateWritingFallback({ ...openRouter({ reasoning_effort: 'none' }), protocol: 'anthropic-messages' }), null)
  assert.equal(candidateWritingFallback({ ...openRouter({ reasoning_effort: 'none' }), baseUrl: 'https://api.openai.com/v1' }), null)
  assert.equal(candidateWritingFallback({ ...openRouter({ reasoning_effort: 'none' }), type: 'antseed' }), null)
})

async function trial(policy: CandidateWritingPolicy, rambled: boolean[]) {
  const retries = []
  for (const value of rambled) {
    const batch = await policy.beginBatch()
    assert.equal(batch.trial, true)
    retries.push(policy.observeRecordedAnswer(value, true))
    policy.endTrialBatch()
  }
  return retries
}

test('clean answers never trigger the fallback and leave no record', async () => {
  const policy = new CandidateWritingPolicy('reasoning-effort-minimal')
  assert.deepEqual(await trial(policy, [false, false, false]), [null, null, null])
  for (let index = 0; index < 10; index += 1) {
    assert.deepEqual(await policy.beginBatch(), { trial: false, strategy: null })
    assert.equal(policy.observeRecordedAnswer(false, false), null)
  }
  assert.equal(policy.summary(), null)
})

test('later batches wait for the trial answers', async () => {
  const policy = new CandidateWritingPolicy('reasoning-effort-minimal')
  const trials = [await policy.beginBatch(), await policy.beginBatch(), await policy.beginBatch()]
  assert.ok(trials.every((batch) => batch.trial))
  let started = false
  const waiting = policy.beginBatch().then((batch) => { started = true; return batch })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, false)
  for (const rambled of [true, true, false]) {
    policy.observeRecordedAnswer(rambled, true)
    policy.endTrialBatch()
  }
  assert.deepEqual(await waiting, { trial: false, strategy: 'reasoning-effort-minimal' })
})

test('one rambling trial answer retries only that batch', async () => {
  const policy = new CandidateWritingPolicy('reasoning-effort-minimal')
  assert.deepEqual(await trial(policy, [true, false, false]), ['reasoning-effort-minimal', null, null])
  assert.deepEqual(await policy.beginBatch(), { trial: false, strategy: null })
  assert.deepEqual(policy.summary(), {
    version: 1, fallbackStrategy: 'reasoning-effort-minimal', ramblingAnswers: 1, retriedBatches: 1, directBatches: 0, recoveredBatches: 0,
  })
})

test('two rambling trial answers send the rest of the build straight to the fallback', async () => {
  const policy = new CandidateWritingPolicy('reasoning-effort-minimal')
  await trial(policy, [true, true, false])
  policy.observeFallbackAnswer(true)
  assert.equal((await policy.beginBatch()).strategy, 'reasoning-effort-minimal')
  assert.equal((await policy.beginBatch()).strategy, 'reasoning-effort-minimal')
  assert.equal(policy.summary()?.directBatches, 2)
  assert.equal(policy.summary()?.recoveredBatches, 1)
})

test('a refused fallback is dropped for the rest of the build', async () => {
  const policy = new CandidateWritingPolicy('reasoning-effort-minimal')
  await trial(policy, [true, true, false])
  policy.refuseFallback('HTTP 400')
  assert.deepEqual(await policy.beginBatch(), { trial: false, strategy: null })
  assert.equal(policy.observeRecordedAnswer(true, false), null)
  assert.equal(policy.summary()?.fallbackRefused, 'HTTP 400')
})

test('a fallback whose first three answers give no list either is dropped for the rest of the build', async () => {
  // DeepSeek V4 Pro on its pinned host: with a little thinking it thought through every token too.
  const policy = new CandidateWritingPolicy('reasoning-effort-minimal')
  await trial(policy, [true, true, true])
  for (let answer = 0; answer < 2; answer += 1) policy.observeFallbackAnswer(false)
  assert.equal((await policy.beginBatch()).strategy, 'reasoning-effort-minimal', 'two failures are not yet enough')
  policy.observeFallbackAnswer(false)
  assert.deepEqual(await policy.beginBatch(), { trial: false, strategy: null })
  assert.equal(policy.observeRecordedAnswer(true, false), null, 'no retry with it either')
  assert.equal(policy.summary()?.fallbackAbandoned, 'its first 3 answers gave no usable list')
  // One usable answer among the first three keeps it.
  const helped = new CandidateWritingPolicy('reasoning-effort-minimal')
  await trial(helped, [true, true, true])
  for (const usable of [false, true, false, false]) helped.observeFallbackAnswer(usable)
  assert.equal((await helped.beginBatch()).strategy, 'reasoning-effort-minimal')
  assert.equal(helped.summary()?.fallbackAbandoned, undefined)
})

test('without a fallback nothing waits and nothing is retried', async () => {
  const policy = new CandidateWritingPolicy(null)
  for (let index = 0; index < 5; index += 1) assert.deepEqual(await policy.beginBatch(), { trial: false, strategy: null })
  assert.equal(policy.observeRecordedAnswer(true, false), null)
  assert.equal(policy.summary()?.fallbackStrategy, null)
})

test('question writing gets the larger limit only when the setting discovery chose still thought', () => {
  const attempt = (strategy: string, reasoningTokens: number) => ({
    strategy, maxTokens: 800, status: null, validAnswers: 10, reasoningTokens, answersOnly: true, truncated: false,
  }) as never
  assert.equal(CANDIDATE_WRITING_MAX_TOKENS, 6000)
  assert.equal(CANDIDATE_WRITING_THINKING_MAX_TOKENS, 16000)
  // Gemini 4 Neon (dry run 5): every setting accepted but ignored, the least-thinking one used.
  assert.equal(candidateWritingMaxTokens({
    strategy: 'disable-thinking',
    attempts: [attempt('reasoning-effort-minimal', 536), attempt('disable-thinking', 496), attempt('enable-thinking-false', 605)],
  }), 16000)
  // `bare` that still thought, and `bare-expanded` after discovery failed.
  assert.equal(candidateWritingMaxTokens({ strategy: 'bare', attempts: [attempt('bare', 295)] }), 16000)
  assert.equal(candidateWritingMaxTokens({ strategy: 'bare-expanded', attempts: [] }), 16000)
  // A setting that turns thinking off, and a `bare` model that does not think, keep the usual limit.
  assert.equal(candidateWritingMaxTokens({
    strategy: 'reasoning-effort-none', attempts: [attempt('reasoning-effort-none', 0)],
  }), 6000)
  assert.equal(candidateWritingMaxTokens({ strategy: 'bare', attempts: [attempt('reasoning-effort-none', 40), attempt('bare', 0)] }), 6000)
  // A bank enrolled before discovery has none stored.
  assert.equal(candidateWritingMaxTokens(undefined), 6000)
})

test('the larger writing limit is recorded even when no answer rambled', () => {
  assert.equal(new CandidateWritingPolicy(null).summary(), null)
  const policy = new CandidateWritingPolicy(null, undefined, 16000)
  assert.equal(policy.maxTokens, 16000)
  assert.deepEqual(policy.summary(), {
    version: 1, fallbackStrategy: null, ramblingAnswers: 0, retriedBatches: 0, directBatches: 0, recoveredBatches: 0, maxTokens: 16000,
  })
})
