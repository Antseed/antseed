import { randomBytes } from 'node:crypto'
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { loadConfig } from '../../config/loader.js'
import type { BuyerClient } from '../console-api/handlers/network-buyer.js'
import { ConsoleError } from '../console-api/router.js'
import { asObject, badRequest } from '../console-api/serialize.js'
import type { AuthConfig, ObservabilitySettings, Settings } from '../console-api/types.js'
import { errorMessage } from '../errors.js'
import { OBSERVABILITY_SETTING, observabilitySettings } from '../observability.js'
import { recordAudit, type Actor, type ServiceContext } from './context.js'

const MAX_OTLP_HEADERS = 20
/** What header values look like to callers who may not read them. */
export const REDACTED = '••••'

/** What the settings services need beyond the common context. */
export interface SettingsContext extends ServiceContext {
  configPath: string
  publicUrl: string | null
  /** The port the gateway forwards to. */
  buyerPort: number
  /** Auth configuration to report; a conservative default when absent. */
  authConfig?: () => Promise<AuthConfig> | AuthConfig
}

function resolveConfigPath(configPath: string): string {
  return configPath.startsWith('~') ? resolve(homedir(), configPath.slice(2)) : resolve(configPath)
}

type JsonObject = Record<string, unknown>

function childObject(parent: JsonObject, key: string): JsonObject {
  const value = parent[key]
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject
  const created: JsonObject = {}
  parent[key] = created
  return created
}

/** Config edits in flight, per file: each waits for the previous one so concurrent PATCHes never lose an update. */
const configLocks = new Map<string, Promise<void>>()

async function withConfigLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = configLocks.get(path) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(() => undefined, () => undefined)
  configLocks.set(path, settled)
  try {
    return await run
  } finally {
    if (configLocks.get(path) === settled) configLocks.delete(path)
  }
}

/** The file a (possibly symlinked) config path points at, so the edit replaces the target rather than the link. */
async function configTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path
    throw error
  }
}

/**
 * Edits the config file in place: reads the raw JSON, lets `mutate` touch
 * only the fields it changes (so everything else, defaults left implicit
 * included, stays as the operator wrote it), and replaces the file
 * atomically with the same mode. A file that does not parse is never
 * overwritten; a missing one is created with just the changed fields.
 * Edits are serialized in-process, and a symlinked config is written
 * through to its target.
 */
export async function patchConfigFile(configPath: string, mutate: (config: JsonObject) => void): Promise<void> {
  const target = await configTarget(resolveConfigPath(configPath))
  await withConfigLock(target, () => patchConfigTarget(target, mutate))
}

async function patchConfigTarget(path: string, mutate: (config: JsonObject) => void): Promise<void> {
  let raw: string | null = null
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let config: JsonObject = {}
  if (raw !== null && raw.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new ConsoleError(409, 'config_unreadable', `The config file ${path} is not valid JSON; fix it before changing settings here`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConsoleError(409, 'config_unreadable', `The config file ${path} is not a JSON object`)
    }
    config = parsed as JsonObject
  }
  mutate(config)
  const mode = raw === null ? 0o600 : (await stat(path)).mode & 0o777
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode })
    await chmod(temp, mode)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

async function authConfig(deps: SettingsContext): Promise<AuthConfig> {
  if (deps.authConfig) return deps.authConfig()
  return { setupRequired: !deps.store.isSetupComplete(), passkey: true, wallet: true, oidc: null, cloudflareAccess: false, apiKeyLogin: true }
}

/**
 * Current settings. OTLP header values can be credentials: they are masked
 * unless `revealSecrets` (an org-admin session; never a management token).
 */
export async function readSettings(deps: SettingsContext, options: { revealSecrets?: boolean } = {}): Promise<Settings> {
  const config = await loadConfig(deps.configPath)
  const observability = observabilitySettings(deps.store)
  const pricing = config.buyer.maxPricing.defaults
  const buyer = config.buyer as typeof config.buyer & { routingPolicy?: { requireVerified?: boolean }; requireVerifier?: boolean }
  return {
    publicUrl: deps.publicUrl,
    buyer: {
      // The port the gateway actually forwards to, which flags or env can set apart from the config.
      proxyPort: deps.buyerPort,
      maxPricing: {
        inputUsdPerMillion: pricing.inputUsdPerMillion,
        outputUsdPerMillion: pricing.outputUsdPerMillion,
        cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion ?? null,
      },
      minPeerReputation: config.buyer.minPeerReputation,
      requireVerifier: Boolean(buyer.requireVerifier ?? buyer.routingPolicy?.requireVerified),
    },
    observability: options.revealSecrets
      ? observability
      : { ...observability, otlpHeaders: Object.fromEntries(Object.keys(observability.otlpHeaders).map((name) => [name, REDACTED])) },
    auth: await authConfig(deps),
  }
}

function originOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * `current` supplies the value of a header sent back masked (a round trip
 * from a redacted read), but only while the endpoint keeps its origin: the
 * saved values are credentials for that collector, so pointing the export
 * elsewhere needs them typed again.
 */
function parseObservability(body: unknown, current: ObservabilitySettings): ObservabilitySettings {
  const input = asObject(body)
  const endpointRaw = input['otlpEndpoint']
  let otlpEndpoint: string | null = null
  if (endpointRaw !== undefined && endpointRaw !== null && endpointRaw !== '') {
    if (typeof endpointRaw !== 'string') throw badRequest('otlpEndpoint must be a URL')
    let url: URL
    try {
      url = new URL(endpointRaw)
    } catch {
      throw badRequest('otlpEndpoint must be a URL')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('otlpEndpoint must be http(s)')
    otlpEndpoint = url.toString()
  }
  // Turning the export off keeps them (nothing is sent anywhere).
  const sameOrigin = otlpEndpoint === null || originOf(otlpEndpoint) === originOf(current.otlpEndpoint)
  const headersRaw = input['otlpHeaders'] ?? {}
  if (!headersRaw || typeof headersRaw !== 'object' || Array.isArray(headersRaw)) throw badRequest('otlpHeaders must be an object of strings')
  const otlpHeaders: Record<string, string> = {}
  for (const [name, value] of Object.entries(headersRaw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw badRequest(`Invalid header "${name}"`)
    if (value === REDACTED) {
      if (!sameOrigin) {
        throw new ConsoleError(400, 'otlp_headers_required', `The export endpoint changed: enter the value of header "${name}" again (saved header values are not sent to a new endpoint)`)
      }
      const kept = current.otlpHeaders[name]
      if (kept === undefined) throw badRequest(`Header "${name}" needs a value`)
      otlpHeaders[name] = kept
      continue
    }
    otlpHeaders[name] = value
  }
  if (Object.keys(otlpHeaders).length > MAX_OTLP_HEADERS) throw badRequest('Too many otlpHeaders')
  const logContent = input['logContent'] ?? false
  if (typeof logContent !== 'boolean') throw badRequest('logContent must be true or false')
  const retention = input['retentionDays'] ?? null
  if (retention !== null && (typeof retention !== 'number' || !Number.isSafeInteger(retention) || retention < 1)) {
    throw badRequest('retentionDays must be a whole number of days or null')
  }
  return { otlpEndpoint, otlpHeaders, logContent, retentionDays: retention as number | null }
}

export interface BuyerSettingsPatch {
  maxPricing?: { inputUsdPerMillion?: number; outputUsdPerMillion?: number; cachedInputUsdPerMillion?: number | null }
  minPeerReputation?: number
}

/** Checks a buyer-settings patch before anything is written. */
function parseBuyerSettingsPatch(body: unknown): BuyerSettingsPatch {
  const input = asObject(body)
  const pricingPatch: NonNullable<BuyerSettingsPatch['maxPricing']> = {}
  if (input['maxPricing'] !== undefined) {
    const pricing = asObject(input['maxPricing'])
    for (const field of ['inputUsdPerMillion', 'outputUsdPerMillion'] as const) {
      if (pricing[field] === undefined) continue
      if (!isNonNegativeNumber(pricing[field])) throw badRequest(`maxPricing.${field} must be a non-negative number`)
      pricingPatch[field] = pricing[field] as number
    }
    const cached = pricing['cachedInputUsdPerMillion']
    if (cached !== undefined) {
      if (cached !== null && !isNonNegativeNumber(cached)) throw badRequest('maxPricing.cachedInputUsdPerMillion must be a non-negative number or null')
      pricingPatch.cachedInputUsdPerMillion = cached as number | null
    }
  }
  const patch: BuyerSettingsPatch = Object.keys(pricingPatch).length > 0 ? { maxPricing: pricingPatch } : {}
  if (input['minPeerReputation'] !== undefined) {
    const value = input['minPeerReputation']
    if (!isNonNegativeNumber(value) || value > 100) throw badRequest('minPeerReputation must be a number between 0 and 100')
    patch.minPeerReputation = value
  }
  return patch
}

/**
 * Applies a buyer-settings patch to the config file (in place, atomically,
 * keeping everything else as written) and asks the buyer to restart to pick
 * it up. `restartRequired` when the buyer could not restart itself (not
 * supervised, or not reachable): the operator has to. `changed` is false for
 * an empty patch, which touches nothing.
 */
export async function updateBuyerSettings(
  ctx: SettingsContext,
  actor: Actor,
  body: unknown,
  buyer: BuyerClient,
): Promise<{ changed: boolean; restartRequired: boolean }> {
  const patch = parseBuyerSettingsPatch(body)
  const pricingPatch = patch.maxPricing ?? {}
  const minPeerReputation = patch.minPeerReputation
  if (Object.keys(pricingPatch).length === 0 && minPeerReputation === undefined) return { changed: false, restartRequired: false }

  await patchConfigFile(ctx.configPath, (config) => {
    const buyerConfig = childObject(config, 'buyer')
    if (Object.keys(pricingPatch).length > 0) {
      const defaults = childObject(childObject(buyerConfig, 'maxPricing'), 'defaults')
      for (const [field, value] of Object.entries(pricingPatch)) {
        if (value === null) delete defaults[field]
        else defaults[field] = value
      }
    }
    if (minPeerReputation !== undefined) buyerConfig['minPeerReputation'] = minPeerReputation
  })
  recordAudit(ctx, actor, 'settings.buyer.update', { kind: 'settings', id: 'buyer', label: 'Buyer settings' }, {
    ...(Object.keys(pricingPatch).length > 0 ? { maxPricing: pricingPatch } : {}),
    ...(minPeerReputation !== undefined ? { minPeerReputation } : {}),
  })
  ctx.log('console: buyer settings changed; restarting the buyer')
  let restartRequired = false
  try {
    const response = await buyer('/_antseed/restart', { method: 'POST' })
    if (!response.ok) {
      const answer = await response.json().catch(() => null) as { error?: unknown } | null
      // A buyer that is not supervised cannot restart itself: the operator has to.
      restartRequired = true
      ctx.log(answer?.error === 'restart_unsupported'
        ? 'console: the buyer cannot restart itself (not supervised); restart it to apply the new settings'
        : `console: buyer restart request answered HTTP ${response.status}`)
    }
  } catch (error) {
    restartRequired = true
    ctx.log(`console: buyer restart request failed: ${errorMessage(error)}`)
  }
  return { changed: true, restartRequired }
}

/**
 * Saves the observability settings (OTLP export, content logging,
 * retention). Where request data goes (the endpoint) and whether prompts
 * are kept is for a signed-in org admin or the operator
 * (`mayChangeDestination`), not a management token: a refused attempt is
 * audited and answered 403 `session_required`.
 */
export function setObservabilitySettings(
  ctx: ServiceContext,
  actor: Actor,
  body: unknown,
  options: { mayChangeDestination: boolean },
): ObservabilitySettings {
  const current = observabilitySettings(ctx.store)
  const settings = parseObservability(body, current)
  const endpointChanged = settings.otlpEndpoint !== current.otlpEndpoint
  const logContentChanged = settings.logContent !== current.logContent
  if ((endpointChanged || logContentChanged) && !options.mayChangeDestination) {
    recordAudit(ctx, actor, 'settings.observability.denied', { kind: 'settings', id: 'observability', label: 'Observability' }, {
      code: 'session_required', endpointChanged, logContentChanged,
    })
    throw new ConsoleError(403, 'session_required', 'Only an org admin signed in to the console can change the export endpoint or content logging; management tokens cannot')
  }
  ctx.store.setSetting(OBSERVABILITY_SETTING, settings)
  recordAudit(ctx, actor, 'settings.observability.update', { kind: 'settings', id: 'observability', label: 'Observability' }, {
    ...(endpointChanged ? { previousOtlpEndpoint: current.otlpEndpoint } : {}),
    ...(logContentChanged ? { previousLogContent: current.logContent } : {}),
    otlpEndpoint: settings.otlpEndpoint,
    // Header names only: values may be credentials.
    otlpHeaders: Object.keys(settings.otlpHeaders),
    logContent: settings.logContent,
    retentionDays: settings.retentionDays,
  })
  ctx.log(`console: observability settings changed (export ${settings.otlpEndpoint ? 'on' : 'off'}, content logging ${settings.logContent ? 'on' : 'off'})`)
  return settings
}
