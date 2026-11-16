import type { NetworkModel, NetworkModelCapability, NetworkModelType } from '../api/types'
import { formatPricePerMillion, formatPriceRange } from './format'

export const MODEL_TYPE_LABELS: Record<NetworkModelType, string> = { text: 'Text', image: 'Image', video: 'Video', decision: 'Decision', speech: 'Speech', data: 'Data' }

export const CAPABILITY_LABELS: Record<NetworkModelCapability, string> = {
  toolUse: 'Tool use', reasoning: 'Reasoning', structuredOutput: 'Structured output', vision: 'Vision',
}

/** The model a `models/<id>` route names, by id or alias (case-insensitive). */
export function findModel(models: readonly NetworkModel[] | undefined, id: string): NetworkModel | null {
  const wanted = id.trim().toLowerCase()
  const list = models ?? []
  return list.find((model) => model.id.toLowerCase() === wanted)
    ?? list.find((model) => model.aliases.some((alias) => alias.toLowerCase() === wanted))
    ?? null
}

/** One line of price for a seller's offer: free, per image, per million speech characters, or input and output per million tokens. */
export function priceSummary(price: {
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  usdPerImage?: { min: number; max: number } | null
  usdPerMillionCharacters?: number
  usdPerRequest?: number
  free?: boolean
}): string {
  if (price.usdPerImage) return price.usdPerImage.max === 0 ? 'Free' : `${formatPriceRange(price.usdPerImage)} per image`
  if (price.usdPerMillionCharacters !== undefined) {
    return price.usdPerMillionCharacters === 0 ? 'Free' : `${formatPricePerMillion(price.usdPerMillionCharacters)} /M characters`
  }
  const { inputUsdPerMillion: input, outputUsdPerMillion: output } = price
  if (input === null && output === null && price.usdPerRequest !== undefined) {
    return price.usdPerRequest === 0 ? 'Free' : `${formatPriceRange({ min: price.usdPerRequest, max: price.usdPerRequest })} per request`
  }
  if (input === null && output === null) return price.free ? 'Free' : 'No price advertised'
  if ((input ?? 0) === 0 && (output ?? 0) === 0) return 'Free'
  return `${formatPricePerMillion(input)} in · ${formatPricePerMillion(output)} out /M`
}
