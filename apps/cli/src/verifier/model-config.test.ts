import assert from 'node:assert/strict'
import test from 'node:test'
import type { VerifierCLIConfig } from '../config/types.js'
import {
  blendedModelPrice,
  configuredVerifierModels,
  excludedVerifierDomains,
  findVerifierModel,
  resolveVerifierCommandModels,
  resolveVerifierModelConfig,
  verifierModelServices,
} from './model-config.js'
import type { VerifierModelCatalog } from './openrouter-catalog.js'
import { AUDITED_MODELS, setAuditedModelsForTesting } from './audited-models.js'

const TEST_MODELS = {
  'model-large': { upstreamModel: 'model-large-upstream' },
  disabled: { upstreamModel: 'disabled' },
  target: { upstreamModel: 'provider/target' },
}
setAuditedModelsForTesting(TEST_MODELS)

function config(): VerifierCLIConfig {
  return {
    contrastSelection: { inputWeight: 0.9, maxPriceRatio: 0.3, maxModels: 3 },
    models: {
      'model-large': { pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 30 } },
      disabled: { contrastModels: ['small-a'] },
    },
    referenceEndpoint: {
      baseUrl: 'https://reference.example/v1',
      sourceId: 'test',
      trust: 'trusted',
      contrastModelBank: {
        weak: {
          upstreamModel: 'small-a',
          pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
          capabilityRank: 10,
        },
        strongest: {
          upstreamModel: 'small-b',
          pricing: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 6 },
          capabilityRank: 30,
        },
        medium: {
          upstreamModel: 'small-c',
          pricing: { inputUsdPerMillion: 2.4, outputUsdPerMillion: 5 },
          capabilityRank: 20,
        },
        expensive: {
          upstreamModel: 'small-d',
          pricing: { inputUsdPerMillion: 4, outputUsdPerMillion: 8 },
          capabilityRank: 100,
        },
      },
    },
  }
}

test('blended price uses the configured input weight', () => {
  assert.equal(blendedModelPrice({ inputUsdPerMillion: 10, outputUsdPerMillion: 30 }, 0.9), 12)
})

test('configured models are every built-in audited model', () => {
  assert.deepEqual(configuredVerifierModels(config()), ['disabled', 'model-large', 'target'])
})

test('excluded domains apply only to their configured model', () => {
  const value = config()
  value.models!['model-large']!.excludedDomains = ['medical']
  assert.deepEqual([...excludedVerifierDomains(value, 'MODEL-LARGE')], ['medical'])
  assert.deepEqual([...excludedVerifierDomains(value, 'disabled')], [])
  assert.deepEqual([...excludedVerifierDomains(value, 'missing')], [])
})

test('built-in service aliases share one logical verifier model', () => {
  setAuditedModelsForTesting({
    ...TEST_MODELS,
    'model-large': { upstreamModel: 'model-large-upstream', serviceAliases: ['model.large', 'vendor/model-large'] },
  })
  try {
    const value = config()
    assert.deepEqual(verifierModelServices(value, 'MODEL-LARGE'), [
      'model-large',
      'model.large',
      'vendor/model-large',
    ])
    assert.deepEqual(resolveVerifierCommandModels(value, 'vendor/model-large', false), ['model-large'])
  } finally {
    setAuditedModelsForTesting(TEST_MODELS)
  }
})

test('the audited model list is built in; config only adds settings', () => {
  setAuditedModelsForTesting(null)
  try {
    const builtIn = Object.keys(AUDITED_MODELS).sort((left, right) => left.localeCompare(right))
    assert.deepEqual(configuredVerifierModels(undefined), builtIn)
    assert.deepEqual(configuredVerifierModels({ models: { 'kimi-k3': { excludedDomains: ['medical'] } } }), builtIn)
    const [, opus] = findVerifierModel({ models: { 'claude-opus-4.6': { excludedDomains: ['medical'] } } }, 'claude-opus-4.6')!
    assert.equal(opus.upstreamModel, 'anthropic/claude-opus-4.6')
    assert.deepEqual(opus.excludedDomains, ['medical'])
    assert.equal(findVerifierModel(undefined, 'not-audited'), undefined)
    // Other spellings of a built-in model resolve to it, matched the way buyers route.
    assert.equal(findVerifierModel(undefined, 'anthropic/claude-opus-5-5-latest')?.[0], 'claude-opus-5.5')
    assert.equal(findVerifierModel(undefined, 'openai/GPT-6.1-Sol')?.[0], 'gpt-6.1-sol')
    assert.equal(findVerifierModel(undefined, 'deepseek-v4-pro-0813')?.[0], 'deepseek-v4-pro-0813')
    assert.equal(findVerifierModel(undefined, 'gpt-6.1')?.[0], undefined)
  } finally {
    setAuditedModelsForTesting(TEST_MODELS)
  }
})

test('command model resolution requires exactly one mode and an audited model', () => {
  assert.deepEqual(resolveVerifierCommandModels(config(), undefined, true), ['disabled', 'model-large', 'target'])
  assert.deepEqual(resolveVerifierCommandModels(config(), 'MODEL-LARGE', false), ['model-large'])
  assert.deepEqual(resolveVerifierCommandModels(config(), 'vendor/Model_Large', false), ['model-large'])
  assert.throws(() => resolveVerifierCommandModels(config(), undefined, false), /exactly one/)
  assert.throws(() => resolveVerifierCommandModels(config(), 'model-large', true), /exactly one/)
  assert.throws(() => resolveVerifierCommandModels(config(), 'missing', false), /not an audited model/)
})

test('automatic contrasts are filtered by blended cost and ranked by capability', () => {
  assert.deepEqual(resolveVerifierModelConfig(config(), 'MODEL-LARGE').contrastModels, [
    'small-b',
    'small-c',
    'small-a',
  ])
})

test('explicit contrasts override automatic selection and enforce the configured cap', () => {
  const value = config()
  value.contrastSelection!.maxModels = 2
  delete value.models!['model-large']!.pricing
  value.models!['model-large']!.contrastModels = ['x', 'y']
  const resolved = resolveVerifierModelConfig(value, 'model-large')
  assert.deepEqual(resolved.contrastModels, ['x', 'y'])
  assert.equal(resolved.pricing, undefined)
  value.models!['model-large']!.contrastModels.push('z')
  assert.throws(() => resolveVerifierModelConfig(value, 'model-large'), /more than 2/)
})

test('automatic selection excludes disabled entries and resolves deterministic ties by key', () => {
  const value = config()
  value.referenceEndpoint!.contrastModelBank = {
    zeta: {
      upstreamModel: 'tie-z',
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      capabilityRank: 50,
    },
    alpha: {
      upstreamModel: 'tie-a',
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
      capabilityRank: 50,
    },
    disabled: {
      enabled: false,
      upstreamModel: 'disabled-tie',
      pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      capabilityRank: 100,
    },
  }
  assert.deepEqual(resolveVerifierModelConfig(value, 'model-large').contrastModels, ['tie-a', 'tie-z'])
})

test('automatic selection accepts fewer than three but rejects zero candidates', () => {
  const value = config()
  value.referenceEndpoint!.contrastModelBank = {
    one: value.referenceEndpoint!.contrastModelBank!.weak!,
  }
  assert.deepEqual(resolveVerifierModelConfig(value, 'model-large').contrastModels, ['small-a'])
  value.referenceEndpoint!.contrastModelBank = {}
  assert.throws(() => resolveVerifierModelConfig(value, 'model-large'), /no contrast models selected/)
})

test('OpenRouter catalog supplies target pricing and ranks eligible scored contrasts', () => {
  const value: VerifierCLIConfig = {
    contrastSelection: {
      catalogSource: 'openrouter', inputWeight: 0.9, maxPriceRatio: 0.3,
      maxModels: 3, minimumIntelligenceIndex: 30,
    },
    referenceEndpoint: {
      baseUrl: 'https://openrouter.ai/api/v1', sourceId: 'openrouter', trust: 'trusted',
    },
  }
  const catalog: VerifierModelCatalog = new Map([
    ['provider/target', {
      upstreamModel: 'provider/target',
      pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 30 },
      capabilityRank: null,
    }],
    ['deepseek/flash', {
      upstreamModel: 'deepseek/flash',
      pricing: { inputUsdPerMillion: 0.09, outputUsdPerMillion: 0.18 },
      capabilityRank: 49.9,
    }],
    ['openai/luna', {
      upstreamModel: 'openai/luna',
      pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.6 },
      capabilityRank: 51.2,
    }],
    ['openai/luna:batch', {
      upstreamModel: 'openai/luna:batch',
      pricing: { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.3 },
      capabilityRank: 99,
    }],
    ['provider/low-score', {
      upstreamModel: 'provider/low-score',
      pricing: { inputUsdPerMillion: 0.01, outputUsdPerMillion: 0.01 },
      capabilityRank: 29.9,
    }],
    ['provider/expensive', {
      upstreamModel: 'provider/expensive',
      pricing: { inputUsdPerMillion: 5, outputUsdPerMillion: 10 },
      capabilityRank: 60,
    }],
  ])
  const resolved = resolveVerifierModelConfig(value, 'target', catalog)
  assert.deepEqual(resolved.pricing, { inputUsdPerMillion: 10, outputUsdPerMillion: 30 })
  assert.deepEqual(resolved.contrastModels, ['openai/luna', 'deepseek/flash'])
})
