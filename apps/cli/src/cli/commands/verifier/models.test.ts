import assert from 'node:assert/strict'
import test from 'node:test'
import { setAuditedModelsForTesting } from '../../../verifier/audited-models.js'
import { describeVerifierModelSources } from './models.js'

test('models use referenceEndpoint unless they name an upstream', () => {
  setAuditedModelsForTesting({
    'model-a': { upstreamModel: 'vendor/model-a', serviceAliases: ['model.a'], contrastModels: ['vendor/model-a-mini'] },
    'model-b': { upstreamModel: 'vendor/model-b', contrastModels: [] },
    'model-c': { upstreamModel: 'vendor/model-c', referenceProvider: ['maker'], contrastModels: ['other/cheap'] },
  })
  try {
    const rows = describeVerifierModelSources({
      referenceEndpoint: { baseUrl: 'https://openrouter.ai/api/v1', sourceId: 'openrouter', trust: 'trusted' },
      upstreams: { maker: { type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY' } },
      models: {
        'model.a': { referenceProvider: { order: ['Provider-A'] } },
        'model-b': { upstream: { name: 'maker', model: 'model-b-native' } },
        'model-c': { contrastModels: ['mine/one', 'mine/two'] },
      },
    })
    assert.deepEqual(rows.map(({ model, source, sourceType, sourceModel, providerPin, providerPinBuiltIn }) => ({
      model, source, sourceType, sourceModel, providerPin, providerPinBuiltIn,
    })), [
      { model: 'model-a', source: 'referenceEndpoint', sourceType: 'default', sourceModel: 'vendor/model-a', providerPin: ['Provider-A'], providerPinBuiltIn: false },
      { model: 'model-b', source: 'maker', sourceType: 'anthropic', sourceModel: 'model-b-native', providerPin: null, providerPinBuiltIn: false },
      { model: 'model-c', source: 'referenceEndpoint', sourceType: 'default', sourceModel: 'vendor/model-c', providerPin: ['maker'], providerPinBuiltIn: true },
    ])
    assert.deepEqual(rows.map(({ model, contrastModels, contrastSource }) => ({ model, contrastModels, contrastSource })), [
      { model: 'model-a', contrastModels: ['vendor/model-a-mini'], contrastSource: 'built-in' },
      { model: 'model-b', contrastModels: [], contrastSource: 'automatic' },
      { model: 'model-c', contrastModels: ['mine/one', 'mine/two'], contrastSource: 'config' },
    ])
  } finally {
    setAuditedModelsForTesting(null)
  }
})
