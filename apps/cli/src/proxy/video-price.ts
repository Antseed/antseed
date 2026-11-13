// ── A video offer's price, as billing prices it ──
// What one seller charges for a plain video create (no reference video): its
// unit billing models evaluated with the attributes billing builds, at each
// resolution it prices. `/v1/models` lists the cheapest on the offer, so a
// host shows it without interpreting billing rules itself.

import { evaluateUnitBilling, isNativeVideoProtocol, type UnitBillingContext, type UnitBillingModelV1, type VideoOptions } from '@antseed/node'
import { nativeVideoAttributes } from '@antseed/api-adapter'

export type VideoOfferPrice = { perSecondUsd: number; perVideoUsd: number }

type VideoOffer = {
  peerId: string
  provider: string
  serviceId: string
  unitBillingModels?: unknown
  capabilities?: unknown
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * The offer's cheapest price for a plain create: per second of video, plus any
 * fixed charge per video. Each resolution the offer announces
 * (`capabilities.video.resolutions`), or else each its billing names, is priced
 * by `evaluateUnitBilling` with the attributes `nativeVideoAttributes` builds
 * from the service, protocol and announced video options, so a base rate with a
 * surcharge on one resolution reads as the base rate. A combination billing
 * would refuse is skipped; null when the offer has no price per second.
 */
export function videoOfferPrice(offer: VideoOffer): VideoOfferPrice | null {
  const options = record(record(offer.capabilities).video) as VideoOptions
  const announced = Array.isArray(options.resolutions)
    ? options.resolutions.filter((resolution): resolution is string => typeof resolution === 'string' && resolution.trim() !== '')
    : []
  let best: VideoOfferPrice | null = null
  for (const [protocol, billing] of Object.entries(record(offer.unitBillingModels))) {
    if (!isNativeVideoProtocol(protocol)) continue
    const model = record(billing) as unknown as UnitBillingModelV1
    const components = Array.isArray(model.components) ? model.components : []
    const has = (unit: string) => components.some((component) => component?.unit === unit)
    if (!has('video_seconds')) continue
    // What a buyer can ask for: the announced set when there is one, else what billing names.
    const resolutions = announced.length > 0 ? [...new Set(announced)] : [...new Set(components.flatMap((component) => {
      const resolution = record(component?.match).resolution
      return typeof resolution === 'string' ? [resolution] : []
    }))]
    for (const resolution of resolutions.length > 0 ? resolutions : [undefined]) {
      const context: UnitBillingContext = {
        sellerPeerId: offer.peerId,
        provider: offer.provider,
        service: offer.serviceId,
        serviceApiProtocol: protocol,
        attributes: nativeVideoAttributes(offer.serviceId, { protocol, action: 'create', referenceVideo: false, ...(resolution ? { resolution } : {}) }, options),
      }
      // Billing throws for a combination it would refuse (no component matches a unit used).
      const usd = (unit: 'video_seconds' | 'video_generations'): number | null => {
        try {
          return Number(evaluateUnitBilling(model, context, { units: { [unit]: 1 } })) / 1_000_000
        } catch {
          return null
        }
      }
      const perSecondUsd = usd('video_seconds')
      const perVideoUsd = has('video_generations') ? usd('video_generations') : 0
      if (perSecondUsd === null || !(perSecondUsd > 0) || perVideoUsd === null) continue
      if (!best || perSecondUsd < best.perSecondUsd || (perSecondUsd === best.perSecondUsd && perVideoUsd < best.perVideoUsd)) {
        best = { perSecondUsd, perVideoUsd }
      }
    }
  }
  return best
}
