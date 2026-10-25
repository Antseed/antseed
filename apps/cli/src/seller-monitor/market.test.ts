import assert from 'node:assert/strict'
import test from 'node:test'
import { fakeNetworkRows } from './fixture.js'
import { blended, marketView, trustOfRow, trustRank, trustSteps } from './market.js'

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
  assert.deepEqual(glm.cheapest, { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 })
  assert.deepEqual(glm.median, { inputUsdPerMillion: 0.75, outputUsdPerMillion: 2.5 })
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
