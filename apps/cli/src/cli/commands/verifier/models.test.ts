import assert from 'node:assert/strict'
import test from 'node:test'
import { setAuditedModelsForTesting } from '../../../verifier/audited-models.js'
import { describeVerifierModelSources } from './models.js'

test('models use referenceEndpoint unless they name an upstream', () => {
  setAuditedModelsForTesting({
    'model-a': { upstreamModel: 'vendor/model-a', serviceAliases: ['model.a'] },
    'model-b': { upstreamModel: 'vendor/model-b' },
    'model-c': { upstreamModel: 'vendor/model-c', referenceProvider: ['maker'] },
  })
  try {
    const rows = describeVerifierModelSources({
      referenceEndpoint: { baseUrl: 'https://openrouter.ai/api/v1', sourceId: 'openrouter', trust: 'trusted' },
      upstreams: { maker: { type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY' } },
      models: {
        'model.a': { referenceProvider: { order: ['Provider-A'] } },
        'model-b': { upstream: { name: 'maker', model: 'model-b-native' } },
      },
    })
    assert.deepEqual(rows.map(({ model, source, sourceType, sourceModel, providerPin, providerPinBuiltIn }) => ({
      model, source, sourceType, sourceModel, providerPin, providerPinBuiltIn,
    })), [
      { model: 'model-a', source: 'referenceEndpoint', sourceType: 'default', sourceModel: 'vendor/model-a', providerPin: ['Provider-A'], providerPinBuiltIn: false },
      { model: 'model-b', source: 'maker', sourceType: 'anthropic', sourceModel: 'model-b-native', providerPin: null, providerPinBuiltIn: false },
      { model: 'model-c', source: 'referenceEndpoint', sourceType: 'default', sourceModel: 'vendor/model-c', providerPin: ['maker'], providerPinBuiltIn: true },
    ])
  } finally {
    setAuditedModelsForTesting(null)
  }
})
