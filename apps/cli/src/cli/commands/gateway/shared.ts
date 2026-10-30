import type { Command } from 'commander'
import chalk from 'chalk'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BUDGET_PERIODS, type BudgetLimits, type BudgetPeriod } from '../../../gateway/limits.js'
import { formatUsdc, optionalUsdcToDecimalString, parseUsdToUsdc } from '../../../gateway/money.js'
import { GatewayStore, type ApiKeyRecord, type MemberRecord, type WorkspaceRecord } from '../../../gateway/store.js'
import type { GatewayTopupConfig } from '../../../gateway/runtime.js'
import { AuthDb } from '../../../gateway/auth/db.js'
import { loadConfig } from '../../../config/loader.js'
import { portInUse } from '../../../gateway/bundle.js'
import { loadOrCreateControlSecret, runningGatewayBuyerPort } from '../../../gateway/buyer-control.js'
import { probeBuyerPolicySupport } from '../../../gateway/buyer-policy-probe.js'
import { GatewayBuyer } from '../../../gateway/buyer-process.js'
import { defaultBuyerClient, type BuyerClient } from '../../../gateway/console-api/handlers/network-buyer.js'
import { ConsoleError } from '../../../gateway/console-api/router.js'
import { CLI_ACTOR, PolicyProblemError, type Actor, type ServiceContext } from '../../../gateway/services/context.js'
import { liveBuyerAddresses } from '../../../gateway/services/wallet-address.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { getGlobalOptions } from '../types.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import { observeCliGatewayAudit } from '../../../telemetry/gateway.js'

export const DEFAULT_GATEWAY_PORT = 8379

/**
 * Descriptions of the spend-cap flags per period: `--daily-limit` … for the
 * admin layer, `--owner-daily-limit` … for the key owner's layer.
 */
const LIMIT_OPTIONS: ReadonlyArray<{ period: BudgetPeriod; admin: string; owner: string }> = [
  { period: 'daily', admin: 'spend cap per UTC day in USD', owner: 'owner-layer cap per UTC day in USD' },
  { period: 'weekly', admin: 'spend cap per UTC week (from Monday) in USD', owner: 'owner-layer cap per UTC week in USD' },
  { period: 'monthly', admin: 'spend cap per UTC calendar month in USD', owner: 'owner-layer cap per UTC month in USD' },
  { period: 'total', admin: 'lifetime spend cap in USD', owner: 'owner-layer lifetime cap in USD' },
]

const CLEARABLE_SUFFIX = ' ("none" removes it)'

/** Commander's key for a limit flag: `--daily-limit` → `dailyLimit`, `--owner-daily-limit` → `ownerDailyLimit`. */
function limitOptionKey(period: BudgetPeriod, owner: boolean): string {
  return owner ? `owner${period[0]!.toUpperCase()}${period.slice(1)}Limit` : `${period}Limit`
}

export function addLimitOptions(cmd: Command, clearable: boolean): Command {
  const suffix = clearable ? CLEARABLE_SUFFIX : ''
  for (const { period, admin } of LIMIT_OPTIONS) cmd.option(`--${period}-limit <usd>`, `${admin}${suffix}`)
  return cmd
}

/** The key owner's own caps (`--owner-daily-limit` …), which only narrow the admin caps. */
export function addOwnerLimitOptions(cmd: Command): Command {
  for (const { period, owner } of LIMIT_OPTIONS) cmd.option(`--owner-${period}-limit <usd>`, `${owner}${CLEARABLE_SUFFIX}`)
  return cmd
}

/** Only the periods the user passed; "none" maps to null (no cap). */
export function parseLimitOptions(options: Record<string, unknown>): Partial<BudgetLimits> {
  return limitsFromOptions(options, false)
}

export function parseOwnerLimitOptions(options: Record<string, unknown>): Partial<BudgetLimits> {
  return limitsFromOptions(options, true)
}

function limitsFromOptions(options: Record<string, unknown>, owner: boolean): Partial<BudgetLimits> {
  const limits: Partial<BudgetLimits> = {}
  for (const { period } of LIMIT_OPTIONS) {
    const raw = options[limitOptionKey(period, owner)]
    if (typeof raw !== 'string') continue
    limits[period] = raw.trim().toLowerCase() === 'none' ? null : parseUsdToUsdc(raw)
  }
  return limits
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
  /** The local buyer's control API, on `buyerPort()`. */
  buyer(): Promise<BuyerClient>
  /** The buyer port: `--buyer-port`, else the running gateway's, else the config's `buyer.proxyPort`. */
  buyerPort(): Promise<number>
}

/** Seams for tests; production asks the running buyer. */
export const gatewayCliRuntime: { buyerAddresses: (buyerPort: number) => Promise<Map<string, string> | null> } = {
  buyerAddresses: (buyerPort) => liveBuyerAddresses(buyerPort),
}

export function addBuyerPortOption(cmd: Command): Command {
  return cmd.option('--buyer-port <number>', 'port of the running buyer (default: the running gateway\'s buyer, else buyer.proxyPort from config)', parsePositiveInteger)
}

/**
 * `--config` and `--data-dir` default independently (`~/.antseed/config.json` and
 * `~/.antseed`), so on a host that runs several roles the buyer limits printed by
 * `settings show` and `routing preview` can come from another role's file without
 * saying so. Returns a note when `--data-dir` holds a config that is not the one
 * being read, so the numbers are not mistaken for this gateway's.
 */
export function configSourceNote(configPath: string, dataDir: string): string | null {
  const sibling = join(dataDir, 'config.json')
  if (resolve(sibling) === resolve(configPath)) return null
  if (!existsSync(sibling)) return null
  return `${sibling} exists but is not read; pass --config ${sibling} to use it`
}

/** Opens the store, runs `fn` and closes it; service errors become plain CLI errors with flag hints. */
export async function withGateway<T>(cmd: Command, fn: (gateway: CliGateway) => Promise<T> | T): Promise<T> {
  const { dataDir, config: configPath } = getGlobalOptions(cmd)
  const store = new GatewayStore(dataDir)
  const sessions = new AuthDb(store.database, () => Date.now())
  const option = (cmd.opts() as { buyerPort?: number }).buyerPort
  const buyerPort = async (): Promise<number> =>
    option ?? runningGatewayBuyerPort(dataDir) ?? (await loadConfig(configPath)).buyer.proxyPort
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
  // Setup-funnel telemetry for steps taken here rather than in the running gateway (docs/telemetry.md).
  const flushTelemetry = observeCliGatewayAudit(store, { configPath, dataDir })
  try {
    return await fn(gateway)
  } catch (error) {
    throw cliError(error)
  } finally {
    store.close()
    await flushTelemetry?.()
  }
}

/** The confirmation a service error asks for (by its code), as the CLI flag that sends it. */
const CONFIRM_FLAGS: Record<string, { field: string; flag: string }> = {
  empty_allow_list: { field: 'send confirmEmpty: true', flag: 'pass --confirm-empty' },
  narrowed: { field: 'send acceptNarrowed: true', flag: 'pass --accept-narrowed' },
}

/** Service errors in CLI terms: confirmations become the matching flags. */
function cliError(error: unknown): unknown {
  if (!(error instanceof ConsoleError)) return error
  let message: string
  if (error instanceof PolicyProblemError) {
    const confirm = CONFIRM_FLAGS[error.code]
    const hinted = confirm ? error.message.replace(confirm.field, confirm.flag) : error.message
    const effective = error.body.error['effectiveRoutingPolicy']
    message = effective ? `${hinted}\nEffective policy: ${JSON.stringify(effective)}` : hinted
  } else {
    message = error.message.endsWith('.') ? error.message : `${error.message}.`
  }
  return Object.assign(new Error(message), { code: error.code })
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

const BUYER_START_WAIT_MS = 60_000

/**
 * Starts a buyer for the gateway on `buyerPort` and stops it when the
 * gateway stops (`gateway start`, `tunnel start`), unless one is already running there (started by hand, a
 * service or the desktop app), which the gateway then uses.
 */
export async function startGatewayBuyer(
  buyerPort: number,
  globalOptions: { dataDir: string; config: string; verbose: boolean },
  log: (message: string) => void,
): Promise<GatewayBuyer | null> {
  if (await portInUse(buyerPort)) {
    log(`using the buyer already running on port ${buyerPort}`)
    return null
  }
  log(`starting a buyer on port ${buyerPort} (run your own with --no-buyer)`)
  const buyer = new GatewayBuyer({
    buyerPort,
    dataDir: globalOptions.dataDir,
    configPath: globalOptions.config,
    verbose: globalOptions.verbose,
    onLog: log,
  })
  buyer.start()
  // Shutdown runs last-registered first, so the gateway stops before its buyer.
  setupShutdownHandler(() => buyer.stop())
  // Serve once the buyer answers the gateway, so the first requests do not
  // fail; a slow start (a long peer lookup) only delays the gateway so long.
  const probe = { buyerPort, secret: loadOrCreateControlSecret(globalOptions.dataDir) }
  const deadline = Date.now() + BUYER_START_WAIT_MS
  while (Date.now() < deadline && await probeBuyerPolicySupport(probe) === 'unknown') {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return buyer
}
