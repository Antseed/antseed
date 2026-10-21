import { describe, expect, it } from 'vitest'
import type { NetworkModel, NetworkRouter } from '../api/types'
import { catalogEntries, catalogFacets, EMPTY_CATALOG_FILTER, favoriteEntries, filterActive, filterCatalog, type CatalogFilter, type FamilyOf } from './catalog'

const model = (id: string, extra: Partial<NetworkModel> = {}): NetworkModel => ({
  id, name: id, aliases: [], type: 'text', tags: [], contextLength: null, capabilities: [], sellers: 1,
  inputUsdPerMillion: { min: 1, max: 1 }, outputUsdPerMillion: { min: 2, max: 2 }, free: false, teeSellers: 0, fullTeeSellers: 0, verifiedSellers: 0, offers: [], ...extra,
})
const router = (serviceId: string, extra: Partial<NetworkRouter> = {}): NetworkRouter => ({
  id: `${'d'.repeat(40)}@${serviceId}`, peerId: 'd'.repeat(40), serviceId, provider: 'fake-routing', name: 'Fake Router', sellerName: 'Fake Seller',
  protocol: 'irp-suggest', options: [], priceUsdPerRequest: 0, free: true, models: ['*'], trustScore: 50, verified: false, verificationLinks: [], ...extra,
})
// Families by name, standing in for the brand-mark resolution.
const familyOf: FamilyOf = ({ label }) => (label.includes('qwen') ? 'Qwen' : label.includes('llama') ? 'Meta' : null)

const entries = catalogEntries([
  model('qwen3-coder', { tags: ['Coding', 'Open weights'], free: true }),
  model('qwen3-vl', { tags: ['Vision', 'Open weights'], teeSellers: 1 }),
  model('llama-image', { type: 'image' }),
], [router('fake-route')])
const keys = (filter: Partial<CatalogFilter>) => filterCatalog(entries, { ...EMPTY_CATALOG_FILTER, ...filter }, familyOf).map((entry) => entry.key)

describe('Models page catalog', () => {
  it('lists the types, tags and families present', () => {
    expect(catalogFacets(entries, familyOf)).toEqual({ types: ['text', 'image', 'router'], tags: ['Coding', 'Open weights', 'Vision'], families: ['Meta', 'Qwen'] })
  })
  it('matches any chosen type, every chosen tag and any chosen family', () => {
    expect(keys({ types: ['router'] })).toEqual([`${'d'.repeat(40)}@fake-route`])
    expect(keys({ types: ['image', 'router'] })).toHaveLength(2)
    expect(keys({ tags: ['Open weights'] })).toEqual(['qwen3-coder', 'qwen3-vl'])
    expect(keys({ tags: ['Open weights', 'Vision'] })).toEqual(['qwen3-vl'])
    expect(keys({ families: ['Meta', 'Qwen'] })).toEqual(['qwen3-coder', 'qwen3-vl', 'llama-image'])
    // A router has no family.
    expect(keys({ families: ['Qwen'], types: ['router'] })).toEqual([])
  })
  it('searches ids, names and aliases case-insensitively', () => {
    const named = catalogEntries([model('open-model-a', { name: 'Open Model A', aliases: ['open-model-a-latest'] })], [])
    const search = (text: string) => filterCatalog(named, { ...EMPTY_CATALOG_FILTER, search: text }, familyOf).length
    expect([search('LATEST'), search('open model a'), search(' text '), search('nothing')]).toEqual([1, 1, 1, 0])
  })
  it('filters free and TEE, and searches routers by their name and seller', () => {
    expect(keys({ free: true })).toEqual(['qwen3-coder', `${'d'.repeat(40)}@fake-route`])
    expect(keys({ tee: true })).toEqual(['qwen3-vl'])
    expect(keys({ search: 'fake seller' })).toEqual([`${'d'.repeat(40)}@fake-route`])
    expect(keys({ search: 'CODING' })).toEqual(['qwen3-coder'])
    expect(filterActive(EMPTY_CATALOG_FILTER)).toBe(false)
    expect(filterActive({ ...EMPTY_CATALOG_FILTER, search: '  ' })).toBe(false)
    expect(filterActive({ ...EMPTY_CATALOG_FILTER, tee: true })).toBe(true)
  })
  it('lists favorites in starred order, by id or alias, skipping ones that are gone', () => {
    const withAlias = catalogEntries([model('open-a', { aliases: ['open-a-latest'] }), model('open-b')], [router('fake-route')])
    expect(favoriteEntries(withAlias, [`${'d'.repeat(40)}@FAKE-ROUTE`, 'gone-model', 'open-a-latest']).map((entry) => entry.key))
      .toEqual([`${'d'.repeat(40)}@fake-route`, 'open-a'])
  })
})
