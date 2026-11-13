import assert from 'node:assert/strict'
import { test } from 'node:test'
import { videoOfferPrice } from './video-price.js'

const offer = (protocol: string, components: unknown[], video: Record<string, unknown> = {}) => ({
  peerId: 'aaaa', provider: 'example', serviceId: 'example-video', capabilities: { video },
  unitBillingModels: { [protocol]: { version: 1, components } },
})

test('a video offer is priced as billing prices a plain create: per resolution, with every component that applies', () => {
  assert.deepEqual(videoOfferPrice(offer('fal-video', [
    { unit: 'video_seconds', priceUsd: 0.17, match: { resolution: '720p' } },
    { unit: 'video_seconds', priceUsd: 0.29, match: { resolution: '1080p' } },
  ])), { perSecondUsd: 0.17, perVideoUsd: 0 })
  // A part matching the service's model applies to every create: $0.10 + $0.20 per second, plus $0.05 per video.
  assert.deepEqual(videoOfferPrice(offer('fal-video', [
    { unit: 'video_seconds', priceUsd: 0.1 },
    { unit: 'video_seconds', priceUsd: 0.2, match: { model: 'example-video' } },
    { unit: 'video_generations', priceUsd: 0.05 },
  ])), { perSecondUsd: 0.3, perVideoUsd: 0.05 })
  // A plain create sends no reference video, so its "false" part applies and the "true" surcharge doesn't.
  assert.deepEqual(videoOfferPrice(offer('fal-video', [
    { unit: 'video_seconds', priceUsd: 0.1 },
    { unit: 'video_seconds', priceUsd: 0.04, match: { reference_video: 'false' } },
    { unit: 'video_seconds', priceUsd: 0.5, match: { reference_video: 'true' } },
  ])), { perSecondUsd: 0.14, perVideoUsd: 0 })
})

test('Venice prices a video create at its announced aspect ratio and audio when the create names none; other protocols do not', () => {
  const components = [{ unit: 'video_seconds', priceUsd: 0.1, match: { resolution: '720p', aspect_ratio: '16:9', audio: 'true' } }]
  assert.deepEqual(videoOfferPrice(offer('venice-video', components, { aspectRatios: ['16:9', '9:16'], audio: true })), { perSecondUsd: 0.1, perVideoUsd: 0 })
  assert.equal(videoOfferPrice(offer('fal-video', components, { aspectRatios: ['16:9'], audio: true })), null)
})

test('an offer without a price per second, or with billing that is not a video protocol, has no video price', () => {
  assert.equal(videoOfferPrice({ peerId: 'bbbb', provider: 'example', serviceId: 'example-video' }), null)
  assert.equal(videoOfferPrice(offer('openai-images', [{ unit: 'output_images', priceUsd: 0.04 }])), null)
})
