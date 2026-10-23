import assert from 'node:assert/strict'
import test from 'node:test'
import type { VerifierCLIConfig } from '../config/types.js'
import {
  auditPriceRejection,
  describeAuditPriceCap,
  resolveAuditPriceCap,
  resolveAuditPriceCaps,
} from './audit-price.js'
import type { VerifierModelCatalog } from './openrouter-catalog.js'

const endpoint = {
  baseUrl: 'https://openrouter.test/api/v1',
  apiKeyEnv: 'OPENROUTER_TEST_KEY',
  sourceId: 'openrouter',
  trust: 'trusted' as const,
}

const catalog: VerifierModelCatalog = new Map([
  ['anthropic/claude-fable-5.1', {
    upstreamModel: 'anthropic/claude-fable-5.1',
    pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
    capabilityRank: 80,
  }],
  ['x-ai/grok-4.7', {
    upstreamModel: 'x-ai/grok-4.7',
    pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 6 },
    capabilityRank: 70,
  }],
])

test('the audit price cap is the OpenRouter catalog price by default', () => {
  const cap = resolveAuditPriceCap({ referenceEndpoint: endpoint }, 'claude-fable-5.1', catalog)
  assert.deepEqual(cap, {
    model: 'claude-fable-5.1',
    reference: { inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
    source: 'catalog',
    ratio: 1,
  })
  assert.equal(describeAuditPriceCap(cap), 'claude-fable-5.1 ≤ $10/$50 per 1M (reference catalog)')
  // Aliases resolve to the built-in model.
  assert.equal(resolveAuditPriceCap({ referenceEndpoint: endpoint }, 'grok-4-7', catalog).model, 'grok-4.7')
})

test('a reference route or upstream price wins over configured pricing and the catalog', () => {
  const config: VerifierCLIConfig = {
    referenceEndpoint: endpoint,
    upstreams: { trusted: { type: 'antseed', peerId: 'a'.repeat(40) } },
    models: { 'claude-fable-5.1': { upstream: { name: 'trusted', pricing: { inputUsdPerMillion: 8, outputUsdPerMillion: 40 } } } },
  }
  const cap = resolveAuditPriceCap(config, 'claude-fable-5.1', catalog)
  assert.equal(cap.source, 'reference-route')
  assert.deepEqual(cap.reference, { inputUsdPerMillion: 8, outputUsdPerMillion: 40 })

  const configured = resolveAuditPriceCap({
    referenceEndpoint: endpoint,
    models: { 'claude-fable-5.1': { pricing: { inputUsdPerMillion: 9, outputUsdPerMillion: 45 } } },
  }, 'claude-fable-5.1', catalog)
  assert.equal(configured.source, 'configured')
  assert.deepEqual(configured.reference, { inputUsdPerMillion: 9, outputUsdPerMillion: 45 })
})

test('a model without any reference price cannot be audited', () => {
  assert.throws(
    () => resolveAuditPriceCap({ referenceEndpoint: endpoint }, 'kimi-k3', catalog),
    /no reference price for kimi-k3: moonshotai\/kimi-k3 is not priced/,
  )
})

test('auditPriceRatio scales the cap', () => {
  const cap = resolveAuditPriceCap({ referenceEndpoint: endpoint, auditPriceRatio: 1.1 }, 'grok-4.7', catalog)
  assert.equal(cap.ratio, 1.1)
  assert.equal(auditPriceRejection({ inputUsdPerMillion: 2.2, outputUsdPerMillion: 6.6 }, cap), null)
  assert.match(auditPriceRejection({ inputUsdPerMillion: 2.3, outputUsdPerMillion: 6 }, cap) ?? '', /above the grok-4.7 reference \$2\/\$6 × 1.1/)
})

test('the run resolves every model, loads the catalog at most once, and reports unpriced models', async () => {
  let loads = 0
  const { caps, unpriced } = await resolveAuditPriceCaps(
    { referenceEndpoint: endpoint },
    ['claude-fable-5.1', 'grok-4.7', 'kimi-k3'],
    async () => { loads += 1; return catalog },
  )
  assert.equal(loads, 1)
  assert.deepEqual([...caps.keys()], ['claude-fable-5.1', 'grok-4.7'])
  assert.deepEqual([...unpriced.keys()], ['kimi-k3'])

  const failed = await resolveAuditPriceCaps({ referenceEndpoint: endpoint }, ['grok-4.7'], async () => {
    throw new Error('OpenRouter model catalog 503: down')
  })
  assert.equal(failed.caps.size, 0)
  assert.match(failed.unpriced.get('grok-4.7') ?? '', /loading the reference catalog failed: OpenRouter model catalog 503/)
})
