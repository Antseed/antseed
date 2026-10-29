import assert from 'node:assert/strict'
import test from 'node:test'
import { fakeNetworkRows } from './fixture.js'
import { blended, marketView, trustOfRow, trustRank, trustSteps } from './market.js'
import { unitPriceOf } from './unit-price.js'
import { unitPriceText } from './card.js'

const ME = '0x5e11e5e11e5e11e5e11e5e11e5e11e5e11e5e11e'
const meta = { source: 'test', refreshedAt: 1, refreshing: false, error: null, peers: 0 }
const mine = [
  { provider: 'openai', service: 'glm-5.3', inputUsdPerMillion: 0.7, outputUsdPerMillion: 2.2, cachedInputUsdPerMillion: 0.08, inherited: false },
  { provider: 'openai', service: 'kimi-k3', inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5, cachedInputUsdPerMillion: null, inherited: true },
  { provider: 'openai', service: 'my-fine-tune', inputUsdPerMillion: 2, outputUsdPerMillion: 6, cachedInputUsdPerMillion: null, inherited: false },
]

test('market: competitors, cheapest, median, rank and delta per service; unique and not-offered models', () => {
  const rows = fakeNetworkRows(ME, { 'glm-5.3': [0.9, 3], 'kimi-k3': [0.6, 2.5] })
  const market = marketView(rows, ME, mine, meta)
  assert.equal(market.found, true)
  const glm = market.services.find((service) => service.service === 'glm-5.3')!
  assert.equal(glm.competitors, 5)
  assert.deepEqual(glm.cheapest, { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2, unitUsd: null })
  assert.deepEqual(glm.median, { inputUsdPerMillion: 0.75, outputUsdPerMillion: 2.5, unitUsd: null })
  assert.equal(glm.unit, null)
  // Configured prices win over what the network last saw (0.9 / 3).
  assert.equal(glm.mine.blendedUsdPerMillion, blended(0.7, 2.2))
  assert.equal(glm.rank, 2)
  assert.equal(glm.of, 6)
  assert.equal(glm.offers.filter((offer) => offer.mine).length, 1)
  assert.ok(glm.deltaPct! < 0)
  assert.equal(glm.offers.find((offer) => offer.name === 'Fake Seller Alpha')!.tee, true)
  const unique = market.services.find((service) => service.service === 'my-fine-tune')!
  assert.deepEqual([unique.unique, unique.competitors, unique.rank, unique.of, unique.deltaPct], [true, 0, 1, 1, null])
  assert.deepEqual(market.notOffered.slice(0, 3).map((entry) => entry.service), ['deepseek-v4.1', 'qwen3-coder-480b-turbo', 'gemma-4-e4b'])
  assert.equal(market.notOffered.find((entry) => entry.service === 'gemma-4-e4b')!.cheapestOutputUsdPerMillion, 0)
})

test('market without config uses the announced services; a seller not found still lists them', () => {
  const rows = fakeNetworkRows(ME, { 'glm-5.3': [0.9, 3] })
  assert.deepEqual(marketView(rows, ME, null, meta).services.map((service) => [service.service, service.mine.inputUsdPerMillion]), [['glm-5.3', 0.9]])
  const absent = marketView(rows.slice(1), ME, mine, meta)
  assert.equal(absent.found, false)
  assert.equal(absent.services.length, 3)
})

test('reputation: trust parts with their maximum, rank among sellers, next steps biggest gain first', () => {
  const rows = fakeNetworkRows(ME, { 'glm-5.3': [0.9, 3] })
  const trust = trustOfRow(rows[0])!
  assert.ok(Math.abs(trust.score - 47.7) < 1e-9)
  assert.deepEqual([trust.history!.max, trust.usage!.max, trust.power!.max, trust.freeModels!.max], [50, 20, 10, 5])
  assert.equal(trust.identity, null)
  assert.deepEqual(trustRank(rows, ME), { position: 6, of: 8 })
  const steps = trustSteps(trust)
  assert.deepEqual(steps.map((step) => step.part), ['identity', 'history', 'usage', 'power'])
  assert.match(steps[0]!.text, /domain or a GitHub/)
  assert.deepEqual(trustSteps({ ...trust, washFlagged: true }).map((step) => step.part), ['wash'])
  assert.equal(trustSteps(null)[0]!.part, 'history')
})

test('market: with no network loaded, nothing is ranked or called only yours', () => {
  const market = marketView([], ME, mine, meta)
  assert.ok(market.services.every((service) => !service.unique && service.rank === null))
})

/** A seller row selling one image model at zero token prices and `perImage` USD per image. */
function imageSeller(peerId: string, name: string, perImage: number | null) {
  return {
    peerId, displayName: name, providers: ['openai'],
    providerPricing: { openai: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } },
    providerServiceCategories: { openai: { services: { 'qwen-image': ['image'] } } },
    providerServiceApiProtocols: { openai: { services: { 'qwen-image': ['openai-images'] } } },
    ...(perImage === null ? {} : { providerServiceUnitBillingModels: { openai: { services: { 'qwen-image': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: perImage }] } } } } } }),
  }
}

test('market: unit-billed models rank by their per-unit price, never by their zero token prices', () => {
  const rows = [imageSeller(ME, 'Me', 0.04), imageSeller('0x' + 'a'.repeat(40), 'Cheaper', 0.02), imageSeller('0x' + 'b'.repeat(40), 'Dearer', 0.06), imageSeller('0x' + 'c'.repeat(40), 'Token priced', null)]
  const image = { provider: 'openai', service: 'qwen-image', inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: null, unitPrice: { unit: 'output_images', name: 'image', minUsd: 0.04, maxUsd: 0.04 } }
  for (const market of [marketView(rows, ME, [image], meta), marketView(rows, ME, null, meta)]) {
    const service = market.services[0]!
    assert.equal(service.unit, 'output_images')
    assert.equal(service.mine.blendedUsdPerMillion, null)
    assert.deepEqual([service.rank, service.of, service.competitors], [2, 3, 3], 'the token-priced offer is not compared')
    assert.deepEqual(service.cheapest, { inputUsdPerMillion: null, outputUsdPerMillion: null, unitUsd: 0.02 })
    assert.equal(service.median!.unitUsd, 0.04)
    assert.equal(service.deltaPct, 0)
    assert.deepEqual(service.offers.slice(0, 2).map((offer) => [offer.name, offer.unitPrice?.minUsd]), [['Cheaper', 0.02], ['Me', 0.04]])
  }
  // A token-priced seller of the same model is not ranked against the zero token prices of unit-billed ones.
  const tokens = marketView(rows, ME, [{ ...image, inputUsdPerMillion: 1, outputUsdPerMillion: 2, unitPrice: null }], meta).services[0]!
  assert.deepEqual([tokens.unit, tokens.rank, tokens.of, tokens.cheapest], [null, 2, 2, { inputUsdPerMillion: 0, outputUsdPerMillion: 0, unitUsd: null }])
  // A model this seller does not sell shows its cheapest per-unit price, not "free".
  const other = marketView(rows.slice(1), ME, [], meta).notOffered[0]!
  assert.deepEqual([other.service, other.cheapestOutputUsdPerMillion, other.cheapestUnitPrice], ['qwen-image', 0, { unit: 'output_images', name: 'image', minUsd: 0.02, maxUsd: 0.02 }])
})

test('market: a free image offer is still priced per unit, and a mixed-price service shows its free minimum', () => {
  const rows = [imageSeller(ME, 'Me', 0.04), imageSeller('0x' + 'a'.repeat(40), 'Free images', 0)]
  const market = marketView(rows, ME, null, meta)
  const service = market.services[0]!
  assert.equal(service.unit, 'output_images')
  assert.deepEqual([service.rank, service.of], [2, 2], 'the free offer is compared, and cheaper')
  assert.equal(service.cheapest!.unitUsd, 0)
  assert.deepEqual(unitPriceOf({ 'openai-images': { components: [{ unit: 'output_images', priceUsd: 0 }, { unit: 'output_images', priceUsd: 0.08 }] } }), { unit: 'output_images', name: 'image', minUsd: 0, maxUsd: 0.08 })
  assert.equal(unitPriceOf({ 'openai-images': { components: [{ unit: 'output_images', priceUsd: -1 }] } }), null, 'a negative price is not a price')
  assert.equal(unitPriceText({ name: 'image', minUsd: 0, maxUsd: 0 }), 'Free')
  assert.equal(unitPriceText({ name: 'image', minUsd: 0, maxUsd: 0.08 }), '$0–$0.08 / image')
})
