import { configFromObject, loadConfig } from '../../config/loader.js'
import type { AntseedConfig } from '../../config/types.js'
import { redact } from '../../proxy/chain-rpc.js'
import { optionalBuyerJson, type BuyerClient } from '../console-api/handlers/network-buyer.js'
import { ConsoleError } from '../console-api/router.js'
import { asObject, badRequest } from '../console-api/serialize.js'
import type { AuthConfig, BuyerSettings, BuyerSettingsInput, ObservabilitySettings, Settings } from '../console-api/types.js'
import { errorMessage } from '../errors.js'
import { OBSERVABILITY_SETTING, observabilitySettings } from '../observability.js'
import { recordAudit, type Actor, type ServiceContext } from './context.js'
import { patchConfigFile } from '../../config/patch.js'

export { patchConfigFile }

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

type JsonObject = Record<string, unknown>

function childObject(parent: JsonObject, key: string): JsonObject {
  const value = parent[key]
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject
  const created: JsonObject = {}
  parent[key] = created
  return created
}

async function authConfig(deps: SettingsContext): Promise<AuthConfig> {
  if (deps.authConfig) return deps.authConfig()
  return { setupRequired: !deps.store.isSetupComplete(), passkey: true, wallet: true, oidc: null, cloudflareAccess: false, apiKeyLogin: true }
}

const USDC_UNITS = 1_000_000
const DEFAULT_MAX_PER_REQUEST_USDC = '300000'
const DEFAULT_MAX_RESERVE_USDC = '1000000'

function usdcFromBaseUnits(value: string | undefined, fallback: string): number {
  const units = Number(value ?? fallback)
  return Number.isFinite(units) ? units / USDC_UNITS : Number(fallback) / USDC_UNITS
}

/** RPC URLs carry API keys in their path or query: shown as origin + "/…" unless revealed. */
function maskRpcUrl(url: string, reveal: boolean): string {
  return reveal ? url : redact(url)
}

/** Every buyer setting as the config file holds it; `proxyPort` is the port the gateway forwards to. */
export function buyerSettingsFromConfig(
  config: AntseedConfig,
  options: { proxyPort: number; overrides?: string[]; revealSecrets?: boolean },
): BuyerSettings {
  const buyer = config.buyer
  const pricing = buyer.maxPricing.defaults
  const prefs = buyer.routingPreferences
  const crypto = config.payments.crypto
  const reveal = options.revealSecrets === true
  const verifier = {
    enabled: buyer.verifier?.enabled ?? true,
    prefer: [...(buyer.verifier?.prefer ?? [])],
    require: buyer.verifier?.require ?? false,
  }
  return {
    proxyPort: options.proxyPort,
    maxPricing: {
      inputUsdPerMillion: pricing.inputUsdPerMillion,
      outputUsdPerMillion: pricing.outputUsdPerMillion,
      cachedInputUsdPerMillion: pricing.cachedInputUsdPerMillion ?? null,
    },
    minPeerReputation: buyer.minPeerReputation,
    routingPreferences: {
      minTrustScore: prefs.minTrustScore,
      maxInputUsdPerMillion: prefs.maxInputUsdPerMillion,
      allowedPeerIds: [...prefs.allowedPeerIds],
      blockedPeerIds: [...prefs.blockedPeerIds],
      preferFreePeers: prefs.preferFreePeers,
    },
    verifier,
    requireVerifier: verifier.enabled && verifier.require,
    payments: {
      autoSweep: buyer.autoSweep !== false,
      maxPerRequestUsdc: usdcFromBaseUnits(config.payments.maxPerRequestUsdc, DEFAULT_MAX_PER_REQUEST_USDC),
      maxReserveUsdc: usdcFromBaseUnits(config.payments.maxReserveAmountUsdc, DEFAULT_MAX_RESERVE_USDC),
      rpcUrl: crypto?.rpcUrl ? maskRpcUrl(crypto.rpcUrl, reveal) : null,
      fallbackRpcUrls: (crypto?.fallbackRpcUrls ?? []).map((url) => maskRpcUrl(url, reveal)),
    },
    network: {
      peerRefreshIntervalMs: buyer.peerRefreshIntervalMs,
      metadataFetchTimeoutMs: buyer.metadataFetchTimeoutMs,
      requestTimeoutMs: buyer.requestTimeoutMs,
      maxStreamDurationMs: buyer.maxStreamDurationMs,
      disableMetadataV2Services: buyer.disableMetadataV2Services,
    },
    evidence: {
      sampleRate: buyer.verification?.sampleRate ?? null,
      maxSampleBytes: buyer.verification?.maxSampleBytes ?? null,
    },
    overrides: [...(options.overrides ?? [])],
  }
}

/** Settings the running buyer took from its environment or flags; empty when it cannot say. */
async function buyerOverrides(buyer: BuyerClient | undefined): Promise<string[]> {
  if (!buyer) return []
  const body = await optionalBuyerJson(buyer, '/_antseed/setting-overrides')
  const overrides = body?.['overrides']
  return Array.isArray(overrides) ? overrides.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Current settings. OTLP header values and RPC URLs can be credentials:
 * they are masked unless `revealSecrets` (an org-admin session; never a
 * management token). With `buyer`, the running buyer's env/flag overrides
 * are included.
 */
export async function readSettings(
  deps: SettingsContext,
  options: { revealSecrets?: boolean; buyer?: BuyerClient } = {},
): Promise<Settings> {
  const config = await loadConfig(deps.configPath)
  const observability = observabilitySettings(deps.store)
  return {
    publicUrl: deps.publicUrl,
    buyer: buyerSettingsFromConfig(config, {
      // The port the gateway actually forwards to, which flags or env can set apart from the config.
      proxyPort: deps.buyerPort,
      overrides: await buyerOverrides(options.buyer),
      revealSecrets: options.revealSecrets === true,
    }),
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

export type BuyerSettingsPatch = BuyerSettingsInput

function numberIn(value: unknown, field: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
  const ok = typeof value === 'number' && Number.isFinite(value)
    && (opts.min === undefined || value >= opts.min)
    && (opts.max === undefined || value <= opts.max)
    && (!opts.integer || Number.isInteger(value))
  if (!ok) {
    const range = opts.max !== undefined ? ` from ${opts.min ?? 0} to ${opts.max}` : ` of at least ${opts.min ?? 0}`
    throw badRequest(`${field} must be ${opts.integer ? 'a whole number' : 'a number'}${range}`)
  }
  return value as number
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw badRequest(`${field} must be true or false`)
  return value
}

function peerIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !/^(?:0x)?[0-9a-f]{40}$/i.test(entry.trim()))) {
    throw badRequest(`${field} must be a list of 40-character hex peer ids`)
  }
  return [...new Set((value as string[]).map((entry) => entry.trim().toLowerCase().replace(/^0x/, '')))]
}

function rpcUrlField(value: unknown, field: string): string {
  if (typeof value !== 'string') throw badRequest(`${field} must be an http(s) URL`)
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw badRequest(`${field} must be an http(s) URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest(`${field} must be an http(s) URL`)
  return value.trim()
}

/** A section of the patch body, or undefined when absent. */
function section(input: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return input[key] === undefined ? undefined : asObject(input[key])
}

/** Checks a buyer-settings patch's types and ranges before anything is written. */
function parseBuyerSettingsPatch(body: unknown): BuyerSettingsPatch {
  const input = asObject(body)
  const patch: BuyerSettingsPatch = {}

  const pricing = section(input, 'maxPricing')
  if (pricing) {
    const out: NonNullable<BuyerSettingsPatch['maxPricing']> = {}
    for (const field of ['inputUsdPerMillion', 'outputUsdPerMillion'] as const) {
      if (pricing[field] !== undefined) out[field] = numberIn(pricing[field], `maxPricing.${field}`, { min: 0 })
    }
    const cached = pricing['cachedInputUsdPerMillion']
    if (cached !== undefined) out.cachedInputUsdPerMillion = cached === null ? null : numberIn(cached, 'maxPricing.cachedInputUsdPerMillion', { min: 0 })
    if (Object.keys(out).length > 0) patch.maxPricing = out
  }
  if (input['minPeerReputation'] !== undefined) patch.minPeerReputation = numberIn(input['minPeerReputation'], 'minPeerReputation', { min: 0, max: 100 })

  const prefs = section(input, 'routingPreferences')
  if (prefs) {
    const out: NonNullable<BuyerSettingsPatch['routingPreferences']> = {}
    if (prefs['minTrustScore'] !== undefined) out.minTrustScore = numberIn(prefs['minTrustScore'], 'routingPreferences.minTrustScore', { min: 0, max: 100 })
    if (prefs['maxInputUsdPerMillion'] !== undefined) out.maxInputUsdPerMillion = numberIn(prefs['maxInputUsdPerMillion'], 'routingPreferences.maxInputUsdPerMillion', { min: 0 })
    if (prefs['allowedPeerIds'] !== undefined) out.allowedPeerIds = peerIdList(prefs['allowedPeerIds'], 'routingPreferences.allowedPeerIds')
    if (prefs['blockedPeerIds'] !== undefined) out.blockedPeerIds = peerIdList(prefs['blockedPeerIds'], 'routingPreferences.blockedPeerIds')
    if (prefs['preferFreePeers'] !== undefined) out.preferFreePeers = booleanField(prefs['preferFreePeers'], 'routingPreferences.preferFreePeers')
    if (Object.keys(out).length > 0) patch.routingPreferences = out
  }

  const verifier = section(input, 'verifier')
  if (verifier) {
    const out: NonNullable<BuyerSettingsPatch['verifier']> = {}
    if (verifier['enabled'] !== undefined) out.enabled = booleanField(verifier['enabled'], 'verifier.enabled')
    if (verifier['require'] !== undefined) out.require = booleanField(verifier['require'], 'verifier.require')
    if (verifier['prefer'] !== undefined) {
      const prefer = verifier['prefer']
      if (!Array.isArray(prefer) || prefer.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(id.trim()))) {
        throw badRequest('verifier.prefer must be a list of verifier ids')
      }
      out.prefer = [...new Set((prefer as string[]).map((id) => id.trim()))]
    }
    if (Object.keys(out).length > 0) patch.verifier = out
  }

  const payments = section(input, 'payments')
  if (payments) {
    const out: NonNullable<BuyerSettingsPatch['payments']> = {}
    if (payments['autoSweep'] !== undefined) out.autoSweep = booleanField(payments['autoSweep'], 'payments.autoSweep')
    if (payments['maxPerRequestUsdc'] !== undefined) out.maxPerRequestUsdc = numberIn(payments['maxPerRequestUsdc'], 'payments.maxPerRequestUsdc', { min: 0.000001, max: 1_000_000 })
    if (payments['maxReserveUsdc'] !== undefined) out.maxReserveUsdc = numberIn(payments['maxReserveUsdc'], 'payments.maxReserveUsdc', { min: 0.000001, max: 1_000_000 })
    if (payments['rpcUrl'] !== undefined) out.rpcUrl = payments['rpcUrl'] === null || payments['rpcUrl'] === '' ? null : rpcUrlField(payments['rpcUrl'], 'payments.rpcUrl')
    if (payments['fallbackRpcUrls'] !== undefined) {
      if (!Array.isArray(payments['fallbackRpcUrls'])) throw badRequest('payments.fallbackRpcUrls must be a list of URLs')
      out.fallbackRpcUrls = (payments['fallbackRpcUrls'] as unknown[]).map((url, index) => rpcUrlField(url, `payments.fallbackRpcUrls[${index}]`))
    }
    if (Object.keys(out).length > 0) patch.payments = out
  }

  const network = section(input, 'network')
  if (network) {
    const out: NonNullable<BuyerSettingsPatch['network']> = {}
    if (network['peerRefreshIntervalMs'] !== undefined) out.peerRefreshIntervalMs = numberIn(network['peerRefreshIntervalMs'], 'network.peerRefreshIntervalMs', { min: 1_000, integer: true })
    if (network['metadataFetchTimeoutMs'] !== undefined) out.metadataFetchTimeoutMs = numberIn(network['metadataFetchTimeoutMs'], 'network.metadataFetchTimeoutMs', { min: 100, integer: true })
    if (network['requestTimeoutMs'] !== undefined) out.requestTimeoutMs = numberIn(network['requestTimeoutMs'], 'network.requestTimeoutMs', { min: 1, integer: true })
    if (network['maxStreamDurationMs'] !== undefined) out.maxStreamDurationMs = numberIn(network['maxStreamDurationMs'], 'network.maxStreamDurationMs', { min: 1, integer: true })
    if (network['disableMetadataV2Services'] !== undefined) out.disableMetadataV2Services = booleanField(network['disableMetadataV2Services'], 'network.disableMetadataV2Services')
    if (Object.keys(out).length > 0) patch.network = out
  }

  const evidence = section(input, 'evidence')
  if (evidence) {
    const out: NonNullable<BuyerSettingsPatch['evidence']> = {}
    if (evidence['sampleRate'] !== undefined) out.sampleRate = evidence['sampleRate'] === null ? null : numberIn(evidence['sampleRate'], 'evidence.sampleRate', { min: 0, max: 1 })
    if (evidence['maxSampleBytes'] !== undefined) out.maxSampleBytes = evidence['maxSampleBytes'] === null ? null : numberIn(evidence['maxSampleBytes'], 'evidence.maxSampleBytes', { min: 1, integer: true })
    if (Object.keys(out).length > 0) patch.evidence = out
  }
  return patch
}

function setOrDelete(target: JsonObject, key: string, value: unknown): void {
  if (value === null || value === undefined) delete target[key]
  else target[key] = value
}

function toBaseUnits(usdc: number): string {
  return String(Math.round(usdc * USDC_UNITS))
}

/**
 * Writes a patch into the raw config object, touching only the fields it
 * names. A masked RPC URL sent back unchanged keeps the saved one.
 */
function applyBuyerPatch(config: JsonObject, patch: BuyerSettingsPatch, current: AntseedConfig): void {
  const buyer = childObject(config, 'buyer')
  if (patch.maxPricing) {
    const defaults = childObject(childObject(buyer, 'maxPricing'), 'defaults')
    for (const [field, value] of Object.entries(patch.maxPricing)) setOrDelete(defaults, field, value)
  }
  if (patch.minPeerReputation !== undefined) buyer['minPeerReputation'] = patch.minPeerReputation
  if (patch.routingPreferences) Object.assign(childObject(buyer, 'routingPreferences'), patch.routingPreferences)
  if (patch.verifier) Object.assign(childObject(buyer, 'verifier'), patch.verifier)
  if (patch.network) Object.assign(buyer, patch.network)
  if (patch.evidence) {
    const verification = childObject(buyer, 'verification')
    for (const [field, value] of Object.entries(patch.evidence)) setOrDelete(verification, field, value)
    if (Object.keys(verification).length === 0) delete buyer['verification']
  }
  const payments = patch.payments
  if (payments) {
    if (payments.autoSweep !== undefined) buyer['autoSweep'] = payments.autoSweep
    const paymentsConfig = childObject(config, 'payments')
    if (payments.maxPerRequestUsdc !== undefined) paymentsConfig['maxPerRequestUsdc'] = toBaseUnits(payments.maxPerRequestUsdc)
    if (payments.maxReserveUsdc !== undefined) paymentsConfig['maxReserveAmountUsdc'] = toBaseUnits(payments.maxReserveUsdc)
    if (payments.rpcUrl !== undefined || payments.fallbackRpcUrls !== undefined) {
      const crypto = childObject(paymentsConfig, 'crypto')
      // The file's `payments.crypto` replaces the default one wholesale: keep the chain.
      if (crypto['chainId'] === undefined && current.payments.crypto?.chainId) crypto['chainId'] = current.payments.crypto.chainId
      const savedRpc = current.payments.crypto?.rpcUrl
      if (payments.rpcUrl !== undefined) {
        setOrDelete(crypto, 'rpcUrl', payments.rpcUrl !== null && savedRpc && payments.rpcUrl === redact(savedRpc) ? savedRpc : payments.rpcUrl)
      }
      if (payments.fallbackRpcUrls !== undefined) {
        const saved = current.payments.crypto?.fallbackRpcUrls ?? []
        const urls = payments.fallbackRpcUrls.map((url) => saved.find((existing) => redact(existing) === url) ?? url)
        setOrDelete(crypto, 'fallbackRpcUrls', urls.length > 0 ? urls : null)
      }
    }
  }
}

/** Whether anything outside the routing preferences (which the buyer reloads by itself) changed. */
function needsRestart(before: AntseedConfig, after: AntseedConfig): boolean {
  const comparable = (config: AntseedConfig) => JSON.stringify({
    buyer: { ...config.buyer, routingPreferences: null },
    payments: config.payments,
  })
  return comparable(before) !== comparable(after)
}

/** The patch for the audit log, with RPC URLs reduced to their origin. */
function auditPatch(patch: BuyerSettingsPatch): BuyerSettingsPatch {
  if (!patch.payments || (patch.payments.rpcUrl === undefined && patch.payments.fallbackRpcUrls === undefined)) return patch
  return {
    ...patch,
    payments: {
      ...patch.payments,
      ...(patch.payments.rpcUrl !== undefined ? { rpcUrl: patch.payments.rpcUrl === null ? null : redact(patch.payments.rpcUrl) } : {}),
      ...(patch.payments.fallbackRpcUrls !== undefined ? { fallbackRpcUrls: patch.payments.fallbackRpcUrls.map(redact) } : {}),
    },
  }
}

/**
 * Applies a buyer-settings patch to the config file (in place, atomically,
 * keeping everything else as written). The result is validated exactly as
 * the buyer will load it before anything is written. Routing preferences
 * apply at once (the buyer reloads the file); any other change asks the
 * buyer to restart. `restartRequired` when a restart was needed but the
 * buyer could not restart itself (not supervised, or not reachable): the
 * operator has to. `changed` is false when nothing changed.
 */
export async function updateBuyerSettings(
  ctx: SettingsContext,
  actor: Actor,
  body: unknown,
  buyer: BuyerClient,
): Promise<{ changed: boolean; restartRequired: boolean }> {
  const patch = parseBuyerSettingsPatch(body)
  if (Object.keys(patch).length === 0) return { changed: false, restartRequired: false }

  let restart = false
  let changed = false
  await patchConfigFile(ctx.configPath, (config) => {
    let before: AntseedConfig
    try {
      before = configFromObject(structuredClone(config))
    } catch (error) {
      throw new ConsoleError(409, 'config_invalid', `The config file is not valid (${errorMessage(error)}); fix it before changing settings here`)
    }
    applyBuyerPatch(config, patch, before)
    let after: AntseedConfig
    try {
      after = configFromObject(structuredClone(config))
    } catch (error) {
      throw badRequest(errorMessage(error).replace(/^Invalid config:\s*(- )?/i, '').replace(/\n- /g, '; '))
    }
    changed = JSON.stringify(before) !== JSON.stringify(after)
    restart = needsRestart(before, after)
  })
  if (!changed) return { changed: false, restartRequired: false }
  recordAudit(ctx, actor, 'settings.buyer.update', { kind: 'settings', id: 'buyer', label: 'Buyer settings' }, { ...auditPatch(patch) })
  if (!restart) {
    ctx.log('console: buyer routing preferences changed; the buyer reloads them from the config file')
    return { changed: true, restartRequired: false }
  }
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
  // Turning content logging off also forgets what it kept.
  const clearedBodies = current.logContent && !settings.logContent ? ctx.store.clearRequestContent() : 0
  recordAudit(ctx, actor, 'settings.observability.update', { kind: 'settings', id: 'observability', label: 'Observability' }, {
    ...(endpointChanged ? { previousOtlpEndpoint: current.otlpEndpoint } : {}),
    ...(logContentChanged ? { previousLogContent: current.logContent } : {}),
    ...(clearedBodies ? { clearedBodies } : {}),
    otlpEndpoint: settings.otlpEndpoint,
    // Header names only: values may be credentials.
    otlpHeaders: Object.keys(settings.otlpHeaders),
    logContent: settings.logContent,
    retentionDays: settings.retentionDays,
  })
  ctx.log(`console: observability settings changed (export ${settings.otlpEndpoint ? 'on' : 'off'}, content logging ${settings.logContent ? 'on' : 'off'})`)
  return settings
}
