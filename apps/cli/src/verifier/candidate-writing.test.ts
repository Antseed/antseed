import assert from 'node:assert/strict'
import test from 'node:test'
import { CandidateWritingPolicy, candidateWritingFallback, isRamblingCandidateAnswer } from './candidate-writing.js'

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

test('the fallback is a little thinking, only on OpenRouter routes that turn thinking off', () => {
  assert.equal(candidateWritingFallback(openRouter({ reasoning_effort: 'none' })), 'reasoning-effort-minimal')
  assert.equal(candidateWritingFallback(openRouter({ reasoning: { effort: 'none' } })), 'reasoning-effort-minimal')
  // Always-thinking models already think; other strategies, APIs and Antseed peers are left alone.
  assert.equal(candidateWritingFallback(openRouter({ reasoning: { effort: 'low', exclude: true } })), null)
  assert.equal(candidateWritingFallback(openRouter({ thinking: { type: 'disabled' } })), null)
  assert.equal(candidateWritingFallback(openRouter({})), null)
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

test('without a fallback nothing waits and nothing is retried', async () => {
  const policy = new CandidateWritingPolicy(null)
  for (let index = 0; index < 5; index += 1) assert.deepEqual(await policy.beginBatch(), { trial: false, strategy: null })
  assert.equal(policy.observeRecordedAnswer(true, false), null)
  assert.equal(policy.summary()?.fallbackStrategy, null)
})
