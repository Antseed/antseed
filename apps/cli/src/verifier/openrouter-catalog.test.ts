import assert from 'node:assert/strict'
import test from 'node:test'
import type { VerifierCLIConfig } from '../config/types.js'
import {
  clearVerifierModelCatalogCache,
  isSpeedTierEndpoint,
  loadConfiguredVerifierModelCatalog,
  loadHighestEndpointPrice,
  loadVerifierModelCatalog,
  OPENROUTER_FETCH_ATTEMPTS,
} from './openrouter-catalog.js'

const config: VerifierCLIConfig = {
  contrastSelection: { catalogSource: 'openrouter' },
  referenceEndpoint: {
    baseUrl: 'https://openrouter.test/api/v1',
    apiKeyEnv: 'OPENROUTER_TEST_KEY',
    sourceId: 'openrouter',
    trust: 'trusted',
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

test('catalog loading is disabled when a manual contrast bank is configured', async () => {
  assert.equal(await loadConfiguredVerifierModelCatalog({
    referenceEndpoint: {
      ...config.referenceEndpoint!,
      contrastModelBank: { manual: {
        upstreamModel: 'provider/manual', pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, capabilityRank: 1,
      } },
    },
  }), null)
})

test('the highest endpoint price takes input and output each at their maximum, skipping speed tiers', async () => {
  let requestUrl = ''
  const price = await loadHighestEndpointPrice(config, 'z-ai/glm-5.3', async (url) => {
    requestUrl = String(url)
    return Response.json({ data: { endpoints: [
      { pricing: { prompt: '0.0000014', completion: '0.0000044' } },
      { pricing: { prompt: '0.0000028', completion: '0.0000088' } },
      { pricing: { prompt: '0.0000021', completion: '0.0000099' } },
      { tag: 'openai/ultrafast', pricing: { prompt: '0.00006', completion: '0.0003' } },
      { tag: 'baseten/us/fast', pricing: { prompt: '0.00002', completion: '0.0001' } },
      { tag: 'openai/flex', pricing: { prompt: '0.00005', completion: '0.00005' } },
      { tag: 'alibaba/prime', pricing: { prompt: '0.0000028', completion: '0.0000088' } },
      { pricing: {} },
    ] } })
  })
  assert.equal(requestUrl, 'https://openrouter.test/api/v1/models/z-ai/glm-5.3/endpoints')
  assert.ok(price)
  assert.ok(Math.abs(price.inputUsdPerMillion - 2.8) < 1e-9)
  assert.ok(Math.abs(price.outputUsdPerMillion - 9.9) < 1e-9)
  assert.equal(isSpeedTierEndpoint('openai/ultrafast'), true)
  assert.equal(isSpeedTierEndpoint('fireworks/fast'), true)
  assert.equal(isSpeedTierEndpoint('alibaba/prime'), false)
  assert.equal(isSpeedTierEndpoint('fast'), false)
  assert.equal(await loadHighestEndpointPrice(config, 'x/missing', async () => new Response('', { status: 404 })), null)
})

const pricedCatalog = { data: [{ id: 'a/model', pricing: { prompt: '0.000001', completion: '0.000002' } }] }
const fast = { retryDelayMs: 0 }

test('a catalog that arrives cut off (not valid JSON) is downloaded again', async () => {
  const full = JSON.stringify(pricedCatalog)
  let calls = 0
  const catalog = await loadVerifierModelCatalog(config, async () => {
    calls += 1
    return new Response(calls === 1 ? full.slice(0, 40) : full)
  }, fast)
  assert.equal(calls, 2)
  assert.equal(catalog.get('a/model')?.pricing.outputUsdPerMillion, 2)
})

test('the catalog retries 429/5xx and network errors, and names the URL when it gives up', async () => {
  let calls = 0
  const catalog = await loadVerifierModelCatalog(config, async () => {
    calls += 1
    if (calls === 1) throw new TypeError('terminated')
    if (calls === 2) return new Response('busy', { status: 503 })
    return Response.json(pricedCatalog)
  }, fast)
  assert.equal(calls, 3)
  assert.equal(catalog.size, 1)

  calls = 0
  await assert.rejects(
    loadVerifierModelCatalog(config, async () => { calls += 1; return new Response('{"data":[{"id"') }, fast),
    /OpenRouter model catalog \(https:\/\/openrouter\.test\/api\/v1\/models\) failed after 3 attempts; last: the response \(14 bytes\) was not valid JSON: Expected ':' after property name/,
  )
  assert.equal(calls, OPENROUTER_FETCH_ATTEMPTS)

  calls = 0
  await assert.rejects(
    loadVerifierModelCatalog(config, async () => { calls += 1; return new Response('no key', { status: 401 }) }, fast),
    /OpenRouter model catalog \(https:\/\/openrouter\.test\/api\/v1\/models\) answered HTTP 401: no key/,
  )
  assert.equal(calls, 1)
})

test('endpoint prices retry a cut-off answer and still treat 404 as no endpoints', async () => {
  let calls = 0
  const price = await loadHighestEndpointPrice(config, 'a/model', async () => {
    calls += 1
    const body = JSON.stringify({ data: { endpoints: [{ pricing: { prompt: '0.000001', completion: '0.000003' } }] } })
    return new Response(calls === 1 ? body.slice(0, 30) : body)
  }, fast)
  assert.equal(calls, 2)
  assert.ok(price && Math.abs(price.outputUsdPerMillion - 3) < 1e-9)
})

test('builds running at the same time share one catalog download', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls += 1; return Response.json(pricedCatalog) }) as typeof fetch
  clearVerifierModelCatalogCache()
  try {
    const [first, second] = await Promise.all([loadVerifierModelCatalog(config), loadVerifierModelCatalog(config)])
    assert.equal(first, second)
    await loadVerifierModelCatalog(config)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = original
    clearVerifierModelCatalogCache()
  }
})

test('a failed shared catalog download is not kept', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls += 1; return new Response('nope', { status: 403 }) }) as typeof fetch
  clearVerifierModelCatalogCache()
  try {
    await assert.rejects(loadVerifierModelCatalog(config))
    globalThis.fetch = (async () => { calls += 1; return Response.json(pricedCatalog) }) as typeof fetch
    assert.equal((await loadVerifierModelCatalog(config)).size, 1)
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = original
    clearVerifierModelCatalogCache()
  }
})
