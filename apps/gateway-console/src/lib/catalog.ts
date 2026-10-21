import type { NetworkModel, NetworkModelType, NetworkRouter } from '../api/types'
import { MODEL_TYPE_LABELS } from './models'

/** A row of the Models page: a model, or a routing service that picks one per request. */
export type CatalogEntry =
  | { kind: 'model'; key: string; model: NetworkModel }
  | { kind: 'router'; key: string; router: NetworkRouter }

export type CatalogType = NetworkModelType | 'router'

/**
 * The Models page filters, like the desktop's: types (any of them), tags
 * (all of them), families (any of them), free and TEE only.
 */
export interface CatalogFilter {
  search: string
  types: CatalogType[]
  tags: string[]
  families: string[]
  free: boolean
  tee: boolean
}

export const EMPTY_CATALOG_FILTER: CatalogFilter = { search: '', types: [], tags: [], families: [], free: false, tee: false }

export const CATALOG_TYPE_LABELS: Record<CatalogType, string> = { ...MODEL_TYPE_LABELS, router: 'Router' }

const TYPE_ORDER: readonly CatalogType[] = ['text', 'image', 'video', 'decision', 'router']

/** The vendor family of a model (Anthropic, OpenAI, Qwen…) by its brand mark; null when it has none. */
export type FamilyOf = (entry: { provider: string; label: string }) => string | null

export function catalogEntries(models: readonly NetworkModel[], routers: readonly NetworkRouter[]): CatalogEntry[] {
  return [
    ...models.map((model): CatalogEntry => ({ kind: 'model', key: model.id, model })),
    ...routers.map((router): CatalogEntry => ({ kind: 'router', key: router.id, router })),
  ]
}

export function entryType(entry: CatalogEntry): CatalogType {
  return entry.kind === 'router' ? 'router' : entry.model.type
}

export function entryName(entry: CatalogEntry): string {
  return entry.kind === 'router' ? entry.router.name : entry.model.name
}

export function entryTags(entry: CatalogEntry): string[] {
  return entry.kind === 'router' ? [] : entry.model.tags
}

export function entryFree(entry: CatalogEntry): boolean {
  return entry.kind === 'router' ? entry.router.free : entry.model.free
}

export function entryTee(entry: CatalogEntry): boolean {
  return entry.kind === 'model' && entry.model.teeSellers > 0
}

/** The brand a model's mark and family come from: its first seller's provider and its name. */
export function entryBrand(entry: CatalogEntry): { provider: string; label: string } | null {
  if (entry.kind === 'router') return null
  return { provider: entry.model.offers[0]?.provider ?? '', label: `${entry.model.name} ${entry.model.id}` }
}

function searchText(entry: CatalogEntry): string {
  if (entry.kind === 'router') {
    const { router } = entry
    return [router.name, router.id, router.serviceId, router.provider, router.sellerName ?? '', router.protocol, 'router routing'].join(' ').toLowerCase()
  }
  const { model } = entry
  return [model.id, model.name, ...model.aliases, ...model.tags, ...model.offers.map((offer) => offer.provider), CATALOG_TYPE_LABELS[model.type]].join(' ').toLowerCase()
}

/** The types, tags and families present, in a fixed (types) or alphabetical order, for the filter menus. */
export function catalogFacets(entries: readonly CatalogEntry[], familyOf: FamilyOf): { types: CatalogType[]; tags: string[]; families: string[] } {
  const types = new Set(entries.map(entryType))
  const tags = new Set(entries.flatMap(entryTags))
  const families = new Set(entries.flatMap((entry) => {
    const brand = entryBrand(entry)
    const family = brand ? familyOf(brand) : null
    return family ? [family] : []
  }))
  return {
    types: TYPE_ORDER.filter((type) => types.has(type)),
    tags: [...tags].sort((a, b) => a.localeCompare(b)),
    families: [...families].sort((a, b) => a.localeCompare(b)),
  }
}

export function filterCatalog(entries: readonly CatalogEntry[], filter: CatalogFilter, familyOf: FamilyOf): CatalogEntry[] {
  const needle = filter.search.trim().toLowerCase()
  const types = new Set(filter.types)
  const families = new Set(filter.families)
  return entries.filter((entry) => {
    if (types.size > 0 && !types.has(entryType(entry))) return false
    if (filter.free && !entryFree(entry)) return false
    if (filter.tee && !entryTee(entry)) return false
    if (filter.tags.length > 0) {
      const tags = new Set(entryTags(entry))
      if (!filter.tags.every((tag) => tags.has(tag))) return false
    }
    if (families.size > 0) {
      const brand = entryBrand(entry)
      const family = brand ? familyOf(brand) : null
      if (!family || !families.has(family)) return false
    }
    return !needle || searchText(entry).includes(needle)
  })
}

export function filterActive(filter: CatalogFilter): boolean {
  return Boolean(filter.search.trim() || filter.types.length || filter.tags.length || filter.families.length || filter.free || filter.tee)
}

/**
 * Starred entries, in the order they were starred. A model is starred by its
 * id (or an alias, as an older list may have named it), a router by its
 * `<peerId>@<serviceId>`.
 */
export function favoriteEntries(entries: readonly CatalogEntry[], favorites: readonly string[]): CatalogEntry[] {
  return favorites.flatMap((id) => {
    const wanted = id.toLowerCase()
    const found = entries.find((entry) => entry.key.toLowerCase() === wanted)
      ?? entries.find((entry) => entry.kind === 'model' && entry.model.aliases.some((alias) => alias.toLowerCase() === wanted))
    return found ? [found] : []
  })
}

/** Sort keys for the table: most providers, cheapest first, and so on. Routers have one provider each. */
export function entrySellers(entry: CatalogEntry): number {
  return entry.kind === 'router' ? 1 : entry.model.sellers
}

/** Input price per million tokens, or a router's price per ranking; null when not advertised. */
export function entryInputPrice(entry: CatalogEntry): number | null {
  return entry.kind === 'router' ? entry.router.priceUsdPerRequest : entry.model.inputUsdPerMillion?.min ?? null
}
