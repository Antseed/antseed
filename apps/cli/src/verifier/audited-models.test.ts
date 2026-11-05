import assert from 'node:assert/strict'
import test from 'node:test'
import { AUDITED_MODELS } from './audited-models.js'
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
