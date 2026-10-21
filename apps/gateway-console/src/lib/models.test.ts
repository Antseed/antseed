import { describe, expect, it } from 'vitest'
import type { NetworkModel } from '../api/types'
import { findModel, priceSummary } from './models'

const model = (id: string, extra: Partial<NetworkModel> = {}): NetworkModel => ({
  id, name: id, aliases: [], type: 'text', tags: [], contextLength: null, capabilities: [], sellers: 1,
  inputUsdPerMillion: { min: 1, max: 1 }, outputUsdPerMillion: { min: 2, max: 2 }, free: false, teeSellers: 0, fullTeeSellers: 0, verifiedSellers: 0, offers: [], ...extra,
})

const models = [
  model('open-model-a', { name: 'Open Model A', aliases: ['open-model-a-latest'], free: true }),
  model('open-image-model', { type: 'image' }),
  model('open-video-model', { type: 'video' }),
]

describe('network models', () => {
  it('finds a model by id or alias', () => {
    expect(findModel(models, 'Open-Model-A')?.id).toBe('open-model-a')
    expect(findModel(models, 'open-model-a-latest')?.id).toBe('open-model-a')
    expect(findModel(models, 'missing')).toBeNull()
    expect(findModel(undefined, 'open-model-a')).toBeNull()
  })
})

describe('priceSummary', () => {
  it('reads tokens, images and free offers', () => {
    expect(priceSummary({ inputUsdPerMillion: 0.5, outputUsdPerMillion: 2 })).toBe('$0.50 in · $2.00 out /M')
    expect(priceSummary({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 })).toBe('Free')
    expect(priceSummary({ inputUsdPerMillion: null, outputUsdPerMillion: null, usdPerImage: { min: 0.003, max: 0.003 } })).toBe('$0.003 per image')
    expect(priceSummary({ inputUsdPerMillion: null, outputUsdPerMillion: null })).toBe('No price advertised')
  })
})
