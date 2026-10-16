import { describe, expect, it } from 'vitest'
import type { NetworkModel } from '../api/types'
import { filterModels, findModel, modelTypes, priceSummary } from './models'

const model = (id: string, extra: Partial<NetworkModel> = {}): NetworkModel => ({
  id, name: id, aliases: [], type: 'text', contextLength: null, capabilities: [], sellers: 1,
  inputUsdPerMillion: { min: 1, max: 1 }, outputUsdPerMillion: { min: 2, max: 2 }, free: false, teeSellers: 0, fullTeeSellers: 0, verifiedSellers: 0, offers: [], ...extra,
})

const models = [
  model('open-model-a', { name: 'Open Model A', aliases: ['open-model-a-latest'], free: true }),
  model('open-image-model', { type: 'image' }),
  model('open-video-model', { type: 'video' }),
]

describe('network models', () => {
  it('lists only the types present, in a fixed order', () => {
    expect(modelTypes([models[2]!, models[0]!, models[1]!])).toEqual(['text', 'image', 'video'])
    expect(modelTypes(undefined)).toEqual([])
  })

  it('searches id, name and aliases, case-insensitively', () => {
    const ids = (search: string) => filterModels(models, { search, type: '', free: false }).map((entry) => entry.id)
    expect(ids('LATEST')).toEqual(['open-model-a'])
    expect(ids('open model a')).toEqual(['open-model-a'])
    expect(ids(' video ')).toEqual(['open-video-model'])
    expect(ids('')).toHaveLength(3)
  })

  it('filters by type and free', () => {
    expect(filterModels(models, { search: '', type: 'image', free: false }).map((entry) => entry.id)).toEqual(['open-image-model'])
    expect(filterModels(models, { search: '', type: '', free: true }).map((entry) => entry.id)).toEqual(['open-model-a'])
    expect(filterModels(models, { search: '', type: 'image', free: true })).toEqual([])
  })

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
