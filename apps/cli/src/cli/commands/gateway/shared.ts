import type { Command } from 'commander'
import chalk from 'chalk'
import { LIMIT_PERIODS, type LimitPeriod, type SpendLimits } from '../../../gateway/limits.js'
import { formatUsdc, parseUsdToUsdc } from '../../../gateway/money.js'
import { GatewayStore, type ApiKeyRecord } from '../../../gateway/store.js'
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

export function slugifyIdentityId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'identity'
}
