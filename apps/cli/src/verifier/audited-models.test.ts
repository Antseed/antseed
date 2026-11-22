import assert from 'node:assert/strict'
import test from 'node:test'
import { AUDITED_MODELS } from './audited-models.js'
import { FLIPS_REQUESTS } from './methods/flips/flips-score.js'
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

test('every audited model has FLIPS request settings measured for it, Fable 5.2 included', () => {
  for (const service of Object.keys(AUDITED_MODELS)) assert.ok(FLIPS_REQUESTS[service], `${service} has no FLIPS request settings`)
  assert.deepEqual(Object.keys(FLIPS_REQUESTS).filter((service) => !AUDITED_MODELS[service]), [], 'FLIPS settings for a model that is not audited')
})

test('Claude Fable 5.2 is audited on Anthropic\'s own endpoint, with Fable 5.1\'s former contrast models and not Fable 5.1 itself', () => {
  const fable52 = AUDITED_MODELS['claude-fable-5.2']!
  assert.equal(fable52.upstreamModel, 'anthropic/claude-fable-5.2')
  assert.deepEqual(fable52.referenceProvider, ['anthropic'])
  assert.deepEqual([...fable52.contrastModels], ['anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-terra'])
  assert.equal(AUDITED_MODELS['claude-fable-5.1'], undefined, 'Fable 5.1 is not audited: only the newest version of a model line is')
  assert.ok(!fable52.contrastModels.includes('anthropic/claude-fable-5.1'), 'Fable 5.1 costs more than Fable 5.2: no seller gains by serving it')
})
