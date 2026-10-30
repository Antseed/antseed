import type { SellerStatus, SellerUnitPrice, SellerUsageDay } from '../api/types'
import { formatPriceRange } from './format'

export type AvailableSeller = Extract<SellerStatus, { available: true }>

const DAY_MS = 86_400_000

/** Today and the last 7 UTC days (today included) from the daily series. */
export function usageTotals(days: SellerUsageDay[], now = Date.now()) {
  const todayStart = now - (now % DAY_MS)
  const today = days.find((day) => day.day === todayStart)
  const week = days.filter((day) => day.day > todayStart - 7 * DAY_MS)
  return {
    requestsToday: today?.requests ?? 0,
    revenueToday: today?.revenueUsd ?? 0,
    revenueWeek: week.reduce((sum, day) => sum + day.revenueUsd, 0),
    requestsWeek: week.reduce((sum, day) => sum + day.requests, 0),
  }
}

/** One calm line per thing the operator should look at, most urgent first. */
export function sellerNotices(status: AvailableSeller, now = Date.now()): string[] {
  const lines: string[] = []
  if (!status.running) {
    lines.push(status.updatedAt
      ? `The seller is not running. It last reported ${Math.max(1, Math.round((now - status.updatedAt) / 60_000))} min ago.`
      : 'The seller is not running. Start it with antseed seller start.')
  }
  if (status.gas?.depleted) {
    lines.push(`Out of gas: the seller wallet holds ${formatEth(status.gas.balanceEth)} ETH, below the ${formatEth(status.gas.minBalanceEth)} ETH minimum. Advertising is paused until it is funded.`)
  }
  const failing = status.models.filter((model) => model.status === 'failing')
  if (failing.length > 0) {
    const names = failing.slice(0, 3).map((model) => model.service).join(', ')
    const more = failing.length > 3 ? ` and ${failing.length - 3} more` : ''
    lines.push(`${failing.length} model${failing.length === 1 ? ' is' : 's are'} failing health checks, so buyers skip ${failing.length === 1 ? 'it' : 'them'}: ${names}${more}.`)
  }
  if (status.alerts?.lastError) lines.push(`The last alert could not be delivered: ${status.alerts.lastError}`)
  // The daemon's own notices (today only the out-of-gas one, already covered above).
  for (const notice of status.notices) if (!(status.gas?.depleted && notice.startsWith('Out of gas'))) lines.push(notice)
  return lines
}

const UNIT_NAMES: Record<string, string> = { output_images: 'image', video_generations: 'video', video_seconds: 'video second', completed_requests: 'request' }

/** "image", "video second": what one billing unit is (the seller's own names, as in its unit prices). */
export function unitName(unit: string): string {
  return UNIT_NAMES[unit] ?? unit.replace(/_/g, ' ')
}

/** "$0.02 / image", or "$0.02–$0.04 / image" when size or quality changes the price. */
export function formatUnitPrice(price: Pick<SellerUnitPrice, 'name' | 'minUsd' | 'maxUsd'>): string {
  if (price.maxUsd === 0) return 'Free'
  return `${formatPriceRange({ min: price.minUsd, max: price.maxUsd })} / ${price.name}`
}

/** Up to 4 decimals, more for tiny balances (0.00005), trailing zeros dropped. */
export function formatEth(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value === 0) return '0'
  const decimals = value >= 0.001 ? 4 : Math.min(18, Math.ceil(-Math.log10(value)) + 1)
  return value.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')
}

/** The probe detail, prefixed with its status code unless the detail already names it. */
export function lastResult(model: AvailableSeller['models'][number]): string {
  if (model.lastStatusCode === null) return model.lastDetail ?? '—'
  if (!model.lastDetail) return `HTTP ${model.lastStatusCode}`
  return model.lastDetail.includes(String(model.lastStatusCode)) ? model.lastDetail : `HTTP ${model.lastStatusCode} · ${model.lastDetail}`
}

/** A UTC day start as "Oct 12" (the series is in UTC days, whatever the viewer's timezone). */
export function formatUtcDay(dayStart: number): string {
  return new Date(dayStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
