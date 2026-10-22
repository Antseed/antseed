import assert from 'node:assert/strict'
import test from 'node:test'
import type { VerifierCLIConfig } from '../config/types.js'
import { loadConfiguredVerifierModelCatalog } from './openrouter-catalog.js'

const config: VerifierCLIConfig = {
  contrastSelection: { catalogSource: 'openrouter' },
  referenceEndpoint: {
    baseUrl: 'https://openrouter.test/api/v1',
    apiKeyEnv: 'OPENROUTER_TEST_KEY',
    sourceId: 'openrouter',
    trust: 'trusted',
    models: { target: { upstreamModel: 'provider/target' } },
  },
}

test('OpenRouter catalog resolves per-million pricing and Artificial Analysis scores', async () => {
  const previous = process.env.OPENROUTER_TEST_KEY
  process.env.OPENROUTER_TEST_KEY = 'secret'
  try {
    let requestUrl = ''
    let authorization = ''
    const catalog = await loadConfiguredVerifierModelCatalog(config, async (url, init) => {
      requestUrl = String(url)
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      return Response.json({ data: [{
        id: 'deepseek/deepseek-v4-flash-0731',
        pricing: { prompt: '0.00000009', completion: '0.00000018' },
        benchmarks: { artificial_analysis: { intelligence_index: 49.9 } },
        reasoning: { mandatory: true, supported_efforts: ['high', 'medium', 'low'] },
      }, {
        id: 'provider/no-score',
        pricing: { prompt: '0.000001', completion: '0.000002' },
      }] })
    })
    assert.equal(requestUrl, 'https://openrouter.test/api/v1/models')
    assert.equal(authorization, 'Bearer secret')
    assert.deepEqual(catalog?.get('deepseek/deepseek-v4-flash-0731'), {
      upstreamModel: 'deepseek/deepseek-v4-flash-0731',
      pricing: { inputUsdPerMillion: 0.09, outputUsdPerMillion: 0.18 },
      capabilityRank: 49.9,
      reasoning: { mandatory: true, supportedEfforts: ['high', 'medium', 'low'] },
    })
    assert.equal(catalog?.get('provider/no-score')?.capabilityRank, null)
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_TEST_KEY
    else process.env.OPENROUTER_TEST_KEY = previous
  }
})

test('catalog loading is disabled unless OpenRouter is configured', async () => {
  assert.equal(await loadConfiguredVerifierModelCatalog(undefined), null)
})
