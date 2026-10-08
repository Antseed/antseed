import type { Command } from 'commander'
import chalk from 'chalk'
import { BUDGET_PERIODS, type BudgetLimits, type BudgetPeriod } from '../../../gateway/limits.js'
import { formatUsdc, optionalUsdcToDecimalString, parseUsdToUsdc } from '../../../gateway/money.js'
import { GatewayStore, type ApiKeyRecord, type MemberRecord, type WorkspaceRecord } from '../../../gateway/store.js'
import type { GatewayTopupConfig } from '../../../gateway/runtime.js'
import { AuthDb } from '../../../gateway/auth/db.js'
import { loadConfig } from '../../../config/loader.js'
import { loadOrCreateControlSecret } from '../../../gateway/buyer-control.js'
import { defaultBuyerClient, type BuyerClient } from '../../../gateway/console-api/handlers/network-buyer.js'
import { ConsoleError } from '../../../gateway/console-api/router.js'
import { CLI_ACTOR, PolicyProblemError, type Actor, type ServiceContext } from '../../../gateway/services/context.js'
import { liveBuyerAddresses } from '../../../gateway/services/wallet-address.js'
import { getGlobalOptions } from '../types.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'

export const DEFAULT_GATEWAY_PORT = 8379

const LIMIT_OPTION_FLAGS: Record<BudgetPeriod, string> = {
  daily: '--daily-limit <usd>',
  weekly: '--weekly-limit <usd>',
  monthly: '--monthly-limit <usd>',
  total: '--total-limit <usd>',
}

const LIMIT_OPTION_KEYS: Record<BudgetPeriod, string> = {
  daily: 'dailyLimit',
  weekly: 'weeklyLimit',
  monthly: 'monthlyLimit',
  total: 'totalLimit',
}

export function addLimitOptions(cmd: Command, clearable: boolean): Command {
  const suffix = clearable ? ' ("none" removes it)' : ''
  return cmd
    .option(LIMIT_OPTION_FLAGS.daily, `spend cap per UTC day in USD${suffix}`)
    .option(LIMIT_OPTION_FLAGS.weekly, `spend cap per UTC week (from Monday) in USD${suffix}`)
    .option(LIMIT_OPTION_FLAGS.monthly, `spend cap per UTC calendar month in USD${suffix}`)
    .option(LIMIT_OPTION_FLAGS.total, `lifetime spend cap in USD${suffix}`)
}

/** Only the periods the user passed; "none" maps to null (no cap). */
export function parseLimitOptions(options: Record<string, unknown>): Partial<BudgetLimits> {
  return limitsFromOptions(options, LIMIT_OPTION_KEYS)
}

function limitsFromOptions(options: Record<string, unknown>, keys: Record<BudgetPeriod, string>): Partial<BudgetLimits> {
  const limits: Partial<BudgetLimits> = {}
  for (const period of BUDGET_PERIODS) {
    const raw = options[keys[period]]
    if (typeof raw !== 'string') continue
    limits[period] = raw.trim().toLowerCase() === 'none' ? null : parseUsdToUsdc(raw)
  }
  return limits
}

export function openGatewayStore(cmd: Command): { store: GatewayStore; dataDir: string } {
  const { dataDir } = getGlobalOptions(cmd)
  return { store: new GatewayStore(dataDir), dataDir }
}

export function describeLimits(record: { limits: BudgetLimits }): string {
  const parts = BUDGET_PERIODS.flatMap((period) => {
    const limit = record.limits[period] ?? null
    return limit === null ? [] : [`${formatUsdc(limit)} ${period === 'total' ? 'lifetime' : period}`]
  })
  return parts.length > 0 ? parts.join(', ') : 'none'
}

/** A workspace by id or (case-insensitive) name. */
export function requireWorkspace(store: GatewayStore, idOrName: string): WorkspaceRecord {
  const wanted = idOrName.trim()
  const byId = store.getWorkspace(wanted)
  if (byId) return byId
  const matches = store.listWorkspaces().filter((workspace) => workspace.name.toLowerCase() === wanted.toLowerCase())
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) throw new Error(`Several workspaces are named "${wanted}"; use the workspace id (\`antseed gateway workspace list\`).`)
  throw new Error(`Unknown workspace "${wanted}". Run \`antseed gateway workspace list\` to see workspaces.`)
}

/**
 * The gateway store plus the shared service context, as the operator on
 * this machine: changes are audited with actor kind 'cli', and disabling a
 * member or revoking a key ends their console sessions as the console does.
 */
export interface CliGateway {
  store: GatewayStore
  dataDir: string
  configPath: string
  ctx: ServiceContext
  actor: Actor
  /** The local buyer's control API (buyer port from `--buyer-port`, else the config). */
  buyer(): Promise<BuyerClient>
  /** The buyer port the gateway forwards to: `--buyer-port`, else the config's `buyer.proxyPort`. */
  buyerPort(): Promise<number>
}

/** Seams for tests; production asks the running buyer. */
export const gatewayCliRuntime: { buyerAddresses: (buyerPort: number) => Promise<Map<string, string> | null> } = {
  buyerAddresses: (buyerPort) => liveBuyerAddresses(buyerPort),
}

export function addBuyerPortOption(cmd: Command): Command {
  return cmd.option('--buyer-port <number>', 'port of the running buyer (default: buyer.proxyPort from config)', parsePositiveInteger)
}

/** Opens the store, runs `fn` and closes it; service errors become plain CLI errors with flag hints. */
export async function withGateway<T>(cmd: Command, fn: (gateway: CliGateway) => Promise<T> | T): Promise<T> {
  const { dataDir, config: configPath } = getGlobalOptions(cmd)
  const store = new GatewayStore(dataDir)
  const sessions = new AuthDb(store.database, () => Date.now())
  const option = (cmd.opts() as { buyerPort?: number }).buyerPort
  const buyerPort = async (): Promise<number> => option ?? (await loadConfig(configPath)).buyer.proxyPort
  const gateway: CliGateway = {
    store,
    dataDir,
    configPath,
    actor: CLI_ACTOR,
    ctx: {
      store,
      dataDir,
      now: () => Date.now(),
      log: () => undefined,
      warn: (message) => { process.stderr.write(`Warning: ${message}\n`) },
      // The running buyer says which wallet each identity pays from; null (buyer down) falls back to the keys here.
      buyerAddresses: async () => gatewayCliRuntime.buyerAddresses(await buyerPort().catch(() => 0)),
      sessions: {
        revokeMemberSessions: (memberId) => { sessions.deleteMemberSessions(memberId) },
        revokeKeySessions: (keyId) => { sessions.deleteKeySessions(keyId) },
      },
    },
    buyerPort,
    async buyer() {
      return defaultBuyerClient({ buyerPort: await buyerPort(), controlSecret: loadOrCreateControlSecret(dataDir) })
    },
  }
  try {
    return await fn(gateway)
  } catch (error) {
    throw cliError(error)
  } finally {
    store.close()
  }
}

/** Service errors in CLI terms: confirmations become the matching flags. */
function cliError(error: unknown): unknown {
  if (error instanceof PolicyProblemError) {
    const message = error.message
      .replace('send confirmEmpty: true', 'pass --confirm-empty')
      .replace('send acceptNarrowed: true', 'pass --accept-narrowed')
    const effective = error.body.error['effectiveRoutingPolicy']
    const wrapped = new Error(effective ? `${message}\nEffective policy: ${JSON.stringify(effective)}` : message)
    ;(wrapped as Error & { code?: string }).code = error.code
    return wrapped
  }
  if (error instanceof ConsoleError) {
    const wrapped = new Error(error.message.endsWith('.') ? error.message : `${error.message}.`)
    ;(wrapped as Error & { code?: string }).code = error.code
    return wrapped
  }
  return error
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value))
}

export function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
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

export function slugifyIdentityName(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'identity'
}

/** A member by id or (case-insensitive) email. */
export function requireMember(store: GatewayStore, idOrEmail: string): MemberRecord {
  const wanted = idOrEmail.trim()
  const member = store.getMember(wanted) ?? (wanted.includes('@') ? store.findMemberByEmail(wanted.toLowerCase()) : null)
  if (!member) throw new Error(`Unknown member "${wanted}". Run \`antseed gateway member list\` to see member ids.`)
  return member
}

export function requireKey(store: GatewayStore, id: string): ApiKeyRecord {
  const key = store.getKey(id.trim())
  if (!key) throw new Error(`Unknown key "${id}". Run \`antseed gateway key list\` to see key ids.`)
  return key
}

/** `none` → null, else a whole number. */
export function parseCountOrNone(raw: string, flag: string): number | null {
  if (raw.trim().toLowerCase() === 'none') return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} must be a whole number or "none".`)
  return value
}

/** `on`/`off` (also true/false, yes/no). */
export function parseOnOff(raw: string, flag: string): boolean {
  const value = raw.trim().toLowerCase()
  if (['on', 'true', 'yes'].includes(value)) return true
  if (['off', 'false', 'no'].includes(value)) return false
  throw new Error(`${flag} must be on or off.`)
}

export function limitsUsd(limits: BudgetLimits): Record<BudgetPeriod, string | null> {
  return Object.fromEntries(BUDGET_PERIODS.map((period) => [period, optionalUsdcToDecimalString(limits[period])])) as Record<BudgetPeriod, string | null>
}

export function formatTime(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

const OWNER_LIMIT_OPTION_KEYS: Record<BudgetPeriod, string> = {
  daily: 'ownerDailyLimit',
  weekly: 'ownerWeeklyLimit',
  monthly: 'ownerMonthlyLimit',
  total: 'ownerTotalLimit',
}

/** The key owner's own caps (`--owner-daily-limit` …), which only narrow the admin caps. */
export function addOwnerLimitOptions(cmd: Command): Command {
  return cmd
    .option('--owner-daily-limit <usd>', 'owner-layer cap per UTC day in USD ("none" removes it)')
    .option('--owner-weekly-limit <usd>', 'owner-layer cap per UTC week in USD ("none" removes it)')
    .option('--owner-monthly-limit <usd>', 'owner-layer cap per UTC month in USD ("none" removes it)')
    .option('--owner-total-limit <usd>', 'owner-layer lifetime cap in USD ("none" removes it)')
}

export function parseOwnerLimitOptions(options: Record<string, unknown>): Partial<BudgetLimits> {
  return limitsFromOptions(options, OWNER_LIMIT_OPTION_KEYS)
}
