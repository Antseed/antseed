import assert from 'node:assert/strict'
import test from 'node:test'
import { cardPrice, sellerCardSvg, unitPriceText } from './card.js'

test('the seller card is self-contained, escaped and shows the first five models', () => {
  const svg = sellerCardSvg({ displayName: 'A <b>&', peerId: '5e11e5' + '0'.repeat(34), trustScore: 47.7,
    services: Array.from({ length: 7 }, (_, index) => ({ provider: 'openai', service: `model-${index}`, inputUsdPerMillion: 0.5, outputUsdPerMillion: 0 })) })
  assert.ok(svg.includes('A &lt;b&gt;&amp;'))
  assert.ok(svg.includes('>48<'))
  assert.ok(svg.includes('+ 2 more models'))
  assert.ok(svg.includes('Free out'))
  assert.doesNotMatch(svg, /<image|href=/)
  assert.deepEqual([cardPrice(0), cardPrice(0.004), cardPrice(0.7), cardPrice(12)], ['Free', '$0.004', '$0.70', '$12.00'])
})

test('the card shows an image model by its per-image price, not as free', () => {
  const svg = sellerCardSvg({ displayName: 'Images', peerId: null, trustScore: null, services: [
    { service: 'qwen-image', inputUsdPerMillion: 0, outputUsdPerMillion: 0, unitPrice: { unit: 'output_images', name: 'image', minUsd: 0.02, maxUsd: 0.04 } },
    { service: 'glm-5.3', inputUsdPerMillion: 0.7, outputUsdPerMillion: 2.2, unitPrice: null },
  ] })
  assert.match(svg, /\$0\.02–\$0\.04 \/ image/)
  assert.doesNotMatch(svg, /Free in/)
  assert.match(svg, /USD per million tokens, or per unit as shown/)
  assert.equal(unitPriceText({ name: 'video second', minUsd: 0.1, maxUsd: 0.1 }), '$0.10 / video second')
})
