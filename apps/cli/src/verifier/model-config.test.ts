import assert from 'node:assert/strict'
import test from 'node:test'
import type { VerifierCLIConfig } from '../config/types.js'
import {
  blendedModelPrice,
  configuredVerifierModels,
  excludedVerifierDomains,
  resolveVerifierCommandModels,
  resolveVerifierModelConfig,
  verifierModelServices,
} from './model-config.js'
import type { VerifierModelCatalog } from './openrouter-catalog.js'

function config(): VerifierCLIConfig {
  return {
    contrastSelection: { inputWeight: 0.9, maxPriceRatio: 0.3, maxModels: 3 },
    referenceEndpoint: {
      baseUrl: 'https://reference.example/v1',
      sourceId: 'test',
      trust: 'trusted',
      models: {
        'model-large': {
          upstreamModel: 'model-large-upstream',
          pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 30 },
        },
        disabled: {
          enabled: false,
          upstreamModel: 'disabled',
          contrastModels: ['small-a'],
        },
      },
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

test('configured models include enabled entries only', () => {
  assert.deepEqual(configuredVerifierModels(config()), ['model-large'])
})

test('excluded domains apply only to their configured model', () => {
  const value = config()
  value.referenceEndpoint!.models['model-large']!.excludedDomains = ['medical']
  assert.deepEqual([...excludedVerifierDomains(value, 'MODEL-LARGE')], ['medical'])
  assert.deepEqual([...excludedVerifierDomains(value, 'disabled')], [])
  assert.deepEqual([...excludedVerifierDomains(value, 'missing')], [])
})

test('configured service aliases share one logical verifier model', () => {
  const value = config()
  value.referenceEndpoint!.models['model-large']!.serviceAliases = ['model.large', 'vendor/model-large']
  assert.deepEqual(verifierModelServices(value, 'MODEL-LARGE'), [
    'model-large',
    'model.large',
    'vendor/model-large',
  ])
})

test('command model resolution requires exactly one mode and configured enabled models', () => {
  assert.deepEqual(resolveVerifierCommandModels(config(), undefined, true), ['model-large'])
  assert.deepEqual(resolveVerifierCommandModels(config(), 'MODEL-LARGE', false), ['model-large'])
  assert.throws(() => resolveVerifierCommandModels(config(), undefined, false), /exactly one/)
  assert.throws(() => resolveVerifierCommandModels(config(), 'model-large', true), /exactly one/)
  assert.throws(() => resolveVerifierCommandModels(config(), 'disabled', false), /disabled/)
  assert.throws(() => resolveVerifierCommandModels(config(), 'missing', false), /no mapping/)
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
  delete value.referenceEndpoint!.models['model-large']!.pricing
  value.referenceEndpoint!.models['model-large']!.contrastModels = ['x', 'y']
  const resolved = resolveVerifierModelConfig(value, 'model-large')
  assert.deepEqual(resolved.contrastModels, ['x', 'y'])
  assert.equal(resolved.pricing, undefined)
  value.referenceEndpoint!.models['model-large']!.contrastModels.push('z')
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
      models: { target: { upstreamModel: 'provider/target' } },
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
