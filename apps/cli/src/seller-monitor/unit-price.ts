import { isNativeVideoProtocol } from '@antseed/node'
import type { SellerServiceKind, SellerUnitPrice } from '../gateway/console-api/types.js'

/** When a service bills in several units, the one its price is shown in: what a buyer pays per thing made. */
const UNIT_ORDER = ['output_images', 'video_generations', 'video_seconds', 'completed_requests']

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

/**
 * The per-unit price of a service's unit-billing models (`{ [protocol]: { components } }`),
 * as written in config.json or announced in peer metadata: the cheapest and
 * dearest priced component of its main unit. Null when nothing is priced per unit.
 */
export function unitPriceOf(models: unknown): SellerUnitPrice | null {
  const prices = new Map<string, number[]>()
  for (const model of Object.values(record(models))) {
    const components = record(model)['components']
    if (!Array.isArray(components)) continue
    for (const component of components) {
      const { unit, priceUsd } = record(component)
      if (typeof unit !== 'string' || typeof priceUsd !== 'number' || !Number.isFinite(priceUsd) || priceUsd <= 0) continue
      prices.set(unit, [...(prices.get(unit) ?? []), priceUsd])
    }
  }
  const unit = UNIT_ORDER.find((candidate) => prices.has(candidate)) ?? [...prices.keys()][0]
  if (unit === undefined) return null
  const values = prices.get(unit)!
  return { unit, name: unitName(unit), minUsd: Math.min(...values), maxUsd: Math.max(...values) }
}

/** A peer row's announced unit price for one of its services. */
export function unitPriceOfRow(row: Record<string, unknown>, provider: string, service: string): SellerUnitPrice | null {
  return unitPriceOf(record(record(record(row['providerServiceUnitBillingModels'])[provider])['services'])[service])
}

/** What a service makes, the way the network catalog classes it: video and image APIs, else text. */
export function serviceKind(apiProtocols: readonly string[], capabilities: { outputs?: readonly string[]; video?: unknown } = {}): SellerServiceKind {
  const outputs = capabilities.outputs ?? []
  if (apiProtocols.some(isNativeVideoProtocol) || capabilities.video !== undefined || outputs.includes('video')) return 'video'
  if (apiProtocols.includes('typesafe-systemone')) return 'other'
  if (apiProtocols.includes('openai-images') || outputs.includes('image')) return 'image'
  return 'text'
}

const UNIT_NAMES: Record<string, string> = { output_images: 'image', video_generations: 'video', video_seconds: 'video second', completed_requests: 'request' }

/** "image", "video second": what one unit is, for prices shown as "$0.02 / image". */
export function unitName(unit: string): string {
  return UNIT_NAMES[unit] ?? unit.replace(/_/g, ' ')
}
