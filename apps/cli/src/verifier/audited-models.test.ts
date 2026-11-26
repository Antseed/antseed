import assert from 'node:assert/strict'
import test from 'node:test'
import { AUDITED_MODELS } from './audited-models.js'
import { FLIPS_REQUESTS, flipsCounts } from './methods/flips/flips-score.js'
import { DEFAULT_CONTRAST_MAX_MODELS } from './model-config.js'
import { normalized } from './utils.js'

test('every audited model lists its own built-in contrast models', () => {
  for (const [service, model] of Object.entries(AUDITED_MODELS)) {
    const contrasts = model.contrastModels.map(normalized)
    assert.ok(contrasts.length > 0, `${service} has no built-in contrast models`)
    assert.ok(contrasts.length <= DEFAULT_CONTRAST_MAX_MODELS, `${service} lists more than ${DEFAULT_CONTRAST_MAX_MODELS} contrast models`)
    for (const contrast of contrasts) {
      assert.ok(contrast.length > 0, `${service} lists an empty contrast model`)
      assert.ok(!contrast.endsWith(':free'), `${service} lists the free model ${contrast}`)
      assert.notEqual(contrast, normalized(model.upstreamModel), `${service} lists itself as a contrast`)
    }
    assert.equal(new Set(contrasts).size, contrasts.length, `${service} lists a contrast model twice`)
  }
})

/** Audited models the FLIPS eval never measured: FLIPS has no request settings for them and never counts for them. */
const NEVER_MEASURED_BY_FLIPS = ['gemini-4-neon', 'gpt-6.2-astra', 'gpt-6.2-sol']
/** Models no longer audited. */
const RETIRED = ['gemini-3.1-pro-preview', 'gpt-6-astra', 'gpt-6.1-sol', 'minimax-m3']

test('every audited model has FLIPS request settings measured for it, except the models the eval never measured', () => {
  const unmeasured = Object.keys(AUDITED_MODELS).filter((service) => !FLIPS_REQUESTS[service]).sort()
  assert.deepEqual(unmeasured, NEVER_MEASURED_BY_FLIPS)
  for (const service of NEVER_MEASURED_BY_FLIPS) assert.equal(flipsCounts(service), false, `FLIPS never counts for ${service}`)
  assert.deepEqual(Object.keys(FLIPS_REQUESTS).filter((service) => !AUDITED_MODELS[service]), [], 'FLIPS settings for a model that is not audited')
})

test('the audited models: GPT-6.2 Sol and Astra replace GPT-6.1 Sol and GPT-6 Astra, Gemini 4 Neon joins Argon, MiniMax M3 and Gemini 3.1 Pro are not audited', () => {
  assert.deepEqual(Object.keys(AUDITED_MODELS).sort(), [
    'claude-fable-5.2', 'claude-opus-5.5', 'claude-sonnet-5.5', 'deepseek-v4-pro', 'gemini-4-argon', 'gemini-4-neon', 'glm-5.3',
    'gpt-6.2-astra', 'gpt-6.2-sol', 'grok-4.7', 'kimi-k3', 'kimi-k3.1-pro', 'mimo-v2.6-pro', 'qwen3.8-27b',
  ])
  for (const retired of RETIRED) assert.equal(AUDITED_MODELS[retired], undefined, `${retired} is not audited`)
})

test('the new models are pinned to their maker\'s endpoint, with cheaper contrast models and not their older versions', () => {
  const expected = {
    'gpt-6.2-sol': ['openai/gpt-6.2-sol', ['openai'], ['anthropic/claude-haiku-5.5', 'openai/gpt-6-luna', 'openai/gpt-6.1-terra']],
    'gpt-6.2-astra': ['openai/gpt-6.2-astra', ['openai'], ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-terra']],
    'gemini-4-neon': ['google/gemini-4-neon', ['google-ai-studio'], ['anthropic/claude-haiku-5.5', 'xiaomi/mimo-v2.6-pro', 'google/gemini-4-argon']],
  } as const
  for (const [service, [upstreamModel, referenceProvider, contrastModels]] of Object.entries(expected)) {
    const model = AUDITED_MODELS[service]!
    assert.equal(model.upstreamModel, upstreamModel, service)
    assert.deepEqual(model.referenceProvider, referenceProvider, service)
    assert.deepEqual([...model.contrastModels], contrastModels, service)
  }
  // GPT-6.1 Sol costs as much as GPT-6.2 Sol and GPT-6 Astra more than GPT-6.2 Astra: no seller gains by serving them.
  assert.ok(!AUDITED_MODELS['gpt-6.2-sol']!.contrastModels.includes('openai/gpt-6.1-sol'))
  assert.ok(!AUDITED_MODELS['gpt-6.2-astra']!.contrastModels.includes('openai/gpt-6-astra'))
  // Each keeps the number of contrast models its older version had.
  assert.deepEqual(Object.keys(expected).map((service) => AUDITED_MODELS[service]!.contrastModels.length), [3, 2, 3])
})

test('Claude Fable 5.2 is audited on Anthropic\'s own endpoint, with Fable 5.1\'s former contrast models and not Fable 5.1 itself', () => {
  const fable52 = AUDITED_MODELS['claude-fable-5.2']!
  assert.equal(fable52.upstreamModel, 'anthropic/claude-fable-5.2')
  assert.deepEqual(fable52.referenceProvider, ['anthropic'])
  assert.deepEqual([...fable52.contrastModels], ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-terra'])
  assert.equal(AUDITED_MODELS['claude-fable-5.1'], undefined, 'Fable 5.1 is not audited: only the newest version of a model line is')
  assert.ok(!fable52.contrastModels.includes('anthropic/claude-fable-5.1'), 'Fable 5.1 costs more than Fable 5.2: no seller gains by serving it')
})
