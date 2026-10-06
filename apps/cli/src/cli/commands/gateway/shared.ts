import type { Command } from 'commander'
import chalk from 'chalk'
import { LIMIT_PERIODS, type LimitPeriod, type SpendLimits } from '../../../gateway/limits.js'
import { formatUsdc, parseUsdToUsdc } from '../../../gateway/money.js'
import { GatewayStore, type ApiKeyRecord } from '../../../gateway/store.js'
import type { GatewayTopupConfig } from '../../../gateway/runtime.js'
import { getGlobalOptions } from '../types.js'

export const DEFAULT_GATEWAY_PORT = 8379

export const LIMIT_OPTION_FLAGS: Record<LimitPeriod, string> = {
  daily: '--daily-limit <usd>',
  monthly: '--monthly-limit <usd>',
  total: '--total-limit <usd>',
}

const LIMIT_OPTION_KEYS: Record<LimitPeriod, string> = {
  daily: 'dailyLimit',
  monthly: 'monthlyLimit',
  total: 'totalLimit',
}

export function addLimitOptions(cmd: Command, clearable: boolean): Command {
  const suffix = clearable ? ' ("none" removes it)' : ''
  return cmd
    .option(LIMIT_OPTION_FLAGS.daily, `spend cap per UTC day in USD${suffix}`)
    .option(LIMIT_OPTION_FLAGS.monthly, `spend cap per UTC calendar month in USD${suffix}`)
    .option(LIMIT_OPTION_FLAGS.total, `lifetime spend cap in USD${suffix}`)
}

/** Only the periods the user passed; "none" maps to null (no cap). */
export function parseLimitOptions(options: Record<string, unknown>): Partial<SpendLimits> {
  const limits: Partial<SpendLimits> = {}
  for (const period of LIMIT_PERIODS) {
    const raw = options[LIMIT_OPTION_KEYS[period]]
    if (typeof raw !== 'string') continue
    limits[period] = raw.trim().toLowerCase() === 'none' ? null : parseUsdToUsdc(raw)
  }
  return limits
}

export function openGatewayStore(cmd: Command): { store: GatewayStore; dataDir: string } {
  const { dataDir } = getGlobalOptions(cmd)
  return { store: new GatewayStore(dataDir), dataDir }
}

export function describeLimits(key: ApiKeyRecord): string {
  const parts = LIMIT_PERIODS.flatMap((period) => {
    const limit = key.limits[period]
    return limit === null ? [] : [`${formatUsdc(limit)} ${period === 'total' ? 'lifetime' : period}`]
  })
  return parts.length > 0 ? parts.join(', ') : 'none'
}

export function keyStatusLabel(key: ApiKeyRecord, now = Date.now()): string {
  if (key.status === 'revoked') return chalk.red('revoked')
  if (key.expiresAt !== null && key.expiresAt <= now) return chalk.yellow('expired')
  return chalk.green('active')
}

const FACILITATOR_PRESETS: Record<string, string> = {
  cdp: 'https://api.cdp.coinbase.com/platform/v2/x402',
  payai: 'https://facilitator.payai.network',
}
const CDP_HOST = 'api.cdp.coinbase.com'

/**
 * x402 top-ups are on when a facilitator is configured, by flag or
 * ANTSEED_X402_FACILITATOR_URL: a URL, or `cdp` / `payai`. Credentials only
 * come from the environment: CDP_API_KEY_ID + CDP_API_KEY_SECRET for
 * Coinbase CDP, or ANTSEED_X402_FACILITATOR_AUTHORIZATION for a facilitator
 * with a static token.
 */
export function topupConfig(options: { x402Facilitator?: string; topupMinUsd?: string; topupMaxUsd?: string } = {}): GatewayTopupConfig | undefined {
  const requested = (options.x402Facilitator ?? process.env['ANTSEED_X402_FACILITATOR_URL'] ?? '').trim()
  if (!requested) return undefined
  const facilitatorUrl = FACILITATOR_PRESETS[requested.toLowerCase()] ?? requested
  const facilitatorAuthorization = process.env['ANTSEED_X402_FACILITATOR_AUTHORIZATION']?.trim()
  let cdp: GatewayTopupConfig['cdp']
  if (new URL(facilitatorUrl).host === CDP_HOST) {
    const keyId = process.env['CDP_API_KEY_ID']?.trim()
    const keySecret = process.env['CDP_API_KEY_SECRET']?.trim()
    if (!keyId || !keySecret) throw new Error('The Coinbase CDP facilitator needs CDP_API_KEY_ID and CDP_API_KEY_SECRET.')
    cdp = { keyId, keySecret }
  }
  return {
    facilitatorUrl,
    ...(cdp ? { cdp } : {}),
    ...(facilitatorAuthorization ? { facilitatorAuthorization } : {}),
    ...(options.topupMinUsd ? { minUsd: options.topupMinUsd } : {}),
    ...(options.topupMaxUsd ? { maxUsd: options.topupMaxUsd } : {}),
  }
}

export function slugifyIdentityId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'identity'
}
