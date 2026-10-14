import type { NetworkModel, NetworkModelCapability, NetworkModelType } from '../api/types'
import { formatPricePerMillion, formatPriceRange } from './format'

export interface ModelFilter {
  search: string
  /** '' for every type. */
  type: NetworkModelType | ''
  free: boolean
}

export const MODEL_TYPE_LABELS: Record<NetworkModelType, string> = { text: 'Text', image: 'Image', video: 'Video', decision: 'Decision' }

export const CAPABILITY_LABELS: Record<NetworkModelCapability, string> = {
  toolUse: 'Tool use', reasoning: 'Reasoning', structuredOutput: 'Structured output', vision: 'Vision',
}

const TYPE_ORDER: readonly NetworkModelType[] = ['text', 'image', 'video', 'decision']

/** The model types present in the list, in a fixed order, for the type filter. */
export function modelTypes(models: readonly NetworkModel[] | undefined): NetworkModelType[] {
  const present = new Set((models ?? []).map((model) => model.type))
  return TYPE_ORDER.filter((type) => present.has(type))
}

/** Matches the id, display name or any alias (case-insensitive), then the type and free filters. */
export function filterModels(models: readonly NetworkModel[], filter: ModelFilter): NetworkModel[] {
  const needle = filter.search.trim().toLowerCase()
  return models.filter((model) => {
    if (needle && ![model.id, model.name, ...model.aliases].some((value) => value.toLowerCase().includes(needle))) return false
    if (filter.type && model.type !== filter.type) return false
    if (filter.free && !model.free) return false
    return true
  })
}

/** The model a `models/<id>` route names, by id or alias (case-insensitive). */
export function findModel(models: readonly NetworkModel[] | undefined, id: string): NetworkModel | null {
  const wanted = id.trim().toLowerCase()
  const list = models ?? []
  return list.find((model) => model.id.toLowerCase() === wanted)
    ?? list.find((model) => model.aliases.some((alias) => alias.toLowerCase() === wanted))
    ?? null
}

/** One line of price for a seller's offer: free, per image, or input and output per million tokens. */
export function priceSummary(price: {
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  usdPerImage?: { min: number; max: number } | null
  free?: boolean
}): string {
  if (price.usdPerImage) return price.usdPerImage.max === 0 ? 'Free' : `${formatPriceRange(price.usdPerImage)} per image`
  const { inputUsdPerMillion: input, outputUsdPerMillion: output } = price
  if (input === null && output === null) return price.free ? 'Free' : 'No price advertised'
  if ((input ?? 0) === 0 && (output ?? 0) === 0) return 'Free'
  return `${formatPricePerMillion(input)} in · ${formatPricePerMillion(output)} out /M`
}
