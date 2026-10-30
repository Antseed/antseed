import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_FREE_TIER_STAKE_TIERS, DEFAULT_FREE_TIER_WINDOW_MS, DEFAULT_HEALTH_CHECK_FAILURE_THRESHOLD, DEFAULT_HEALTH_CHECK_INTERVAL_MS, DEFAULT_MIN_GAS_BALANCE_WEI, DEFAULT_REFUEL_MAX_USDC_PER_DAY_UNITS, DEFAULT_REFUEL_SWAP_USDC_UNITS, DEFAULT_REFUEL_TRIGGER_WEI, formatEther } from '@antseed/node'
import { DEFAULT_RESTRICTED_COUNTRIES } from '../config/defaults.js'
import { configFromObject, resolveConfigPath } from '../config/loader.js'
import { isPricedSellerService } from '../config/effective.js'
import type { AntseedConfig, SellerFreeTierCLIConfig } from '../config/types.js'
import { ConsoleError } from '../console-error.js'
import type { FreeTierProgramView, SellerUnitComponent, SellerAlertSettings, SellerAlertsPatch, SellerFreeTierProgramSettings, SellerSettings, SellerSettingsPatch } from '../gateway/console-api/types.js'
import { configWritable, patchValidatedConfig } from '../config/patch.js'
import { applyMergePatch, configOverridesPath, overriddenSettings, patchConfigOverrides, readConfigOverridesSync, removeConfigOverrides } from '../config/overrides.js'
import { readDaemonState, readSellerStatus } from './reader.js'
import { serviceKind, unitPriceOf } from './unit-price.js'

export { configWritable }
import { applyAlertOverrides, DEFAULT_TELEGRAM_TOKEN_ENV, readAlertOverrides, readAlertSecrets, readAlertsConfig, resolveAlerts, webhookHost, writeAlertOverrides, writeAlertSecrets, type AlertOverrides } from '../seller-alerts/settings.js'

type JsonObject = Record<string, unknown>

/**
 * The seller's config file: `ANTSEED_SELLER_CONFIG`, else the gateway's own
 * when the seller shares its data dir, else `<sellerDataDir>/config.json`.
 */
export function resolveSellerConfigPath(sellerDataDir: string, fallback: { dataDir: string; configPath: string }, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['ANTSEED_SELLER_CONFIG']?.trim()
  if (explicit) return resolveConfigPath(explicit)
  return sellerDataDir === fallback.dataDir ? resolveConfigPath(fallback.configPath) : join(sellerDataDir, 'config.json')
}

/** The config file's raw JSON; with a data dir, the dashboard's saved overrides applied over it. */
export async function readRaw(configPath: string, dataDir?: string): Promise<JsonObject> {
  const base = await readBaseRaw(configPath)
  if (dataDir === undefined) return base
  return applyMergePatch(base, readOverrides(dataDir) ?? {}) as JsonObject
}

async function readBaseRaw(configPath: string): Promise<JsonObject> {
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new ConsoleError(409, 'config_unreadable', `The config file ${configPath} is not valid JSON; fix it before changing settings here`)
  }
}

function readOverrides(dataDir: string): JsonObject | null {
  try {
    return readConfigOverridesSync(dataDir)
  } catch (error) {
    throw new ConsoleError(409, 'config_unreadable', `${configOverridesPath(dataDir)} is not valid JSON (${(error as Error).message}); fix or delete it`)
  }
}

/**
 * Where the dashboard saves seller settings: the config file when it can be
 * written, else the data dir's overrides file (also once one exists, so a
 * saved override is never shadowed by an edit to the file under it).
 */
export async function sellerConfigAccess(configPath: string, dataDir: string): Promise<SellerConfigAccess> {
  const overrides = readOverrides(dataDir)
  const file = await configWritable(configPath)
  const overridden = overriddenSettings(overrides)
  if (file.writable && !overrides) return { writable: true, reason: null, savesTo: 'config', overridesPath: null, overridden }
  const dir = await dataDirWritable(dataDir)
  if (dir.writable) return { writable: true, reason: null, savesTo: 'overrides', overridesPath: configOverridesPath(dataDir), overridden }
  return { writable: false, reason: `${file.reason ?? ''} ${dir.reason ?? ''}`.trim(), savesTo: null, overridesPath: overrides ? configOverridesPath(dataDir) : null, overridden }
}

export interface SellerConfigAccess {
  writable: boolean
  reason: string | null
  savesTo: 'config' | 'overrides' | null
  overridesPath: string | null
  overridden: string[]
}

/** A validated seller config edit, saved where `sellerConfigAccess` says. */
export async function patchSellerConfig(configPath: string, dataDir: string, mutate: (raw: JsonObject) => void): Promise<void> {
  const access = await sellerConfigAccess(configPath, dataDir)
  if (!access.writable) throw new ConsoleError(409, 'config_read_only', access.reason!)
  if (access.savesTo === 'config') return patchValidatedConfig(configPath, mutate)
  const base = await readBaseRaw(configPath)
  await patchConfigOverrides(dataDir, base, (raw) => {
    loadMerged(raw)
    mutate(raw)
    try {
      configFromObject(structuredClone(raw))
    } catch (error) {
      throw new ConsoleError(400, 'invalid_request', (error as Error).message.replace(/^Invalid config:\s*(- )?/i, '').replace(/\n- /g, '; '))
    }
  })
}

/** Drops every setting saved from the dashboard: the config file alone applies again (at the next restart). */
export async function resetSellerConfigOverrides(dataDir: string): Promise<void> {
  await removeConfigOverrides(dataDir)
}

function loadMerged(raw: JsonObject): AntseedConfig {
  try {
    return configFromObject(structuredClone(raw))
  } catch (error) {
    throw new ConsoleError(409, 'config_invalid', `The config file is not valid (${(error as Error).message}); fix it before changing settings here`)
  }
}

const programSettings = (program: SellerFreeTierCLIConfig | undefined): SellerFreeTierProgramSettings => ({
  maxRequestsPerAddress: program?.maxRequestsPerAddress ?? null,
  maxRequestsPerIp: program?.maxRequestsPerIp ?? null,
  windowMs: program?.windowMs ?? null,
  stakersOnly: program?.stakersOnly === true,
  stakeTiers: program?.stakeTiers ? program.stakeTiers.map((tier) => ({ ...tier })) : null,
})

/** A program as buyers see it advertised (window and tiers resolved to their defaults), the same as the seller's limiter. */
const programView = (program: SellerFreeTierCLIConfig): FreeTierProgramView => ({
  base: {
    maxRequestsPerAddress: program.maxRequestsPerAddress ?? null,
    maxRequestsPerIp: program.maxRequestsPerIp ?? null,
    windowMs: program.windowMs ?? DEFAULT_FREE_TIER_WINDOW_MS,
    ...(program.stakersOnly ? { stakersOnly: true } : {}),
  },
  stakeTiers: (program.stakeTiers ?? DEFAULT_FREE_TIER_STAKE_TIERS).map((tier) => ({ ...tier })),
})

function settingsView(raw: JsonObject, config: AntseedConfig, configPath: string, access: SellerConfigAccess): SellerSettings {
  const seller = config.seller
  const rawSeller = (raw.seller ?? {}) as JsonObject
  // A model's own program is keyed by its id: the seller applies it to every provider offering that id.
  const ownPrograms = new Map<string, SellerFreeTierCLIConfig>()
  for (const entry of Object.values(seller.providers ?? {})) {
    for (const [service, serviceConfig] of Object.entries(entry.services ?? {})) {
      if (serviceConfig.freeTier && !ownPrograms.has(service)) ownPrograms.set(service, serviceConfig.freeTier)
    }
  }
  return {
    configPath,
    writable: access.writable,
    readOnlyReason: access.reason,
    savesTo: access.savesTo,
    overridesPath: access.overridesPath,
    overridden: access.overridden,
    displayName: config.identity.displayName ?? '',
    maxConcurrentBuyers: seller.maxConcurrentBuyers,
    healthCheck: {
      enabled: seller.healthCheck?.enabled !== false,
      intervalMs: seller.healthCheck?.intervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS,
      failureThreshold: seller.healthCheck?.failureThreshold ?? DEFAULT_HEALTH_CHECK_FAILURE_THRESHOLD,
    },
    gasCheck: {
      enabled: seller.gasCheck?.enabled !== false,
      minBalanceEth: seller.gasCheck?.minBalanceEth ?? Number(formatEther(DEFAULT_MIN_GAS_BALANCE_WEI)),
    },
    gasRefuel: {
      enabled: seller.gasRefuel?.enabled !== false,
      triggerBalanceEth: seller.gasRefuel?.triggerBalanceEth ?? Number(formatEther(DEFAULT_REFUEL_TRIGGER_WEI)),
      swapUsdc: seller.gasRefuel?.swapUsdc ?? Number(DEFAULT_REFUEL_SWAP_USDC_UNITS) / 1e6,
      maxUsdcPerDay: seller.gasRefuel?.maxUsdcPerDay ?? Number(DEFAULT_REFUEL_MAX_USDC_PER_DAY_UNITS) / 1e6,
    },
    freeTier: programSettings(seller.freeTier),
    defaultStakeTiers: DEFAULT_FREE_TIER_STAKE_TIERS.map((tier) => ({ ...tier })),
    restrictedCountries: seller.restrictedCountries ?? DEFAULT_RESTRICTED_COUNTRIES,
    restrictedCountriesDefault: rawSeller.restrictedCountries === undefined,
    services: Object.entries(seller.providers ?? {}).flatMap(([provider, entry]) => Object.entries(entry.services ?? {}).map(([service, serviceConfig]) => {
      const pricing = serviceConfig.pricing ?? entry.defaults
      const paid = isPricedSellerService(entry, serviceConfig)
      // Its own program, else on a free model the seller-wide one; a paid model has a free allowance only when it sets one.
      const own = ownPrograms.get(service)
      const program = own ?? (paid ? undefined : seller.freeTier)
      const apiProtocols = Object.keys(serviceConfig.unitBillingModels ?? {})
      return {
        provider,
        service,
        inputUsdPerMillion: pricing?.inputUsdPerMillion ?? null,
        outputUsdPerMillion: pricing?.outputUsdPerMillion ?? null,
        cachedInputUsdPerMillion: pricing?.cachedInputUsdPerMillion ?? null,
        inherited: !serviceConfig.pricing,
        paid,
        unitPrice: unitPriceOf(serviceConfig.unitBillingModels),
        kind: serviceKind(apiProtocols, serviceConfig.capabilities ?? {}),
        apiProtocols,
        freeTier: program ? programView(program) : null,
        ownFreeTier: own ? programSettings(own) : null,
        enabled: serviceConfig.enabled !== false,
        upstreamModel: serviceConfig.upstreamModel ?? null,
        categories: serviceConfig.categories ?? [],
        unitComponents: unitComponentsOf(serviceConfig.unitBillingModels),
      }
    })),
    providers: Object.entries(seller.providers ?? {}).map(([name, entry]) => ({
      name,
      plugin: entry.plugin,
      unitBilled: Object.values(entry.services ?? {}).some((service) => unitComponentsOf(service.unitBillingModels).length > 0),
      singleService: singleServicePlugin(entry.plugin),
      services: Object.keys(entry.services ?? {}).length,
    })),
  }
}

/** Routing plugins that offer exactly one service: no model can be added under them. */
const SINGLE_SERVICE_PLUGINS = new Set(['irp-router', '@antseed/provider-irp-router', 'free-model-router', '@antseed/provider-free-model-router'])
const singleServicePlugin = (plugin: unknown) => typeof plugin === 'string' && SINGLE_SERVICE_PLUGINS.has(plugin)

/** A service's unit-billing components, one per protocol, unit and match, as written. */
function unitComponentsOf(models: unknown): SellerUnitComponent[] {
  const out: SellerUnitComponent[] = []
  if (!models || typeof models !== 'object') return out
  for (const [protocol, model] of Object.entries(models as JsonObject)) {
    const components = model && typeof model === 'object' ? (model as JsonObject).components : undefined
    if (!Array.isArray(components)) continue
    for (const component of components) {
      if (!component || typeof component !== 'object') continue
      const { unit, priceUsd, match } = component as JsonObject
      if (typeof unit !== 'string' || typeof priceUsd !== 'number') continue
      out.push({ protocol, unit, match: match && typeof match === 'object' && !Array.isArray(match) ? match as Record<string, unknown> : null, priceUsd })
    }
  }
  return out
}

export async function readSellerSettings(configPath: string, dataDir: string): Promise<SellerSettings> {
  const raw = await readRaw(configPath, dataDir)
  return settingsView(raw, loadMerged(raw), configPath, await sellerConfigAccess(configPath, dataDir))
}

// ── Patch validation ─────────────────────────────────────────────────────

export function bad(message: string): never {
  throw new ConsoleError(400, 'invalid_request', message)
}

function int(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) bad(`${field} must be a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : ''}`)
  return value
}

function price(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) bad(`${field} must be a price in USD per million tokens, 0 or more`)
  return value
}

function obj(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(`${field} must be an object`)
  return value as JsonObject
}

function child(parent: JsonObject, key: string): JsonObject {
  const existing = parent[key]
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing as JsonObject
  const created: JsonObject = {}
  parent[key] = created
  return created
}

/**
 * Applies the patch to the raw config in place; only the fields it names change. Returns the changed field names.
 * `startedProviders`: the providers the seller runs with (`--provider`), when known; a model must stay on among them.
 */
export function applySellerSettingsPatch(raw: JsonObject, body: unknown, startedProviders: readonly string[] | null = null): string[] {
  const patch = obj(body ?? {}, 'The request body') as SellerSettingsPatch & JsonObject
  const known = new Set(['displayName', 'maxConcurrentBuyers', 'healthCheck', 'gasCheck', 'gasRefuel', 'freeTier', 'restrictedCountries', 'pricing', 'addServices', 'removeServices'])
  for (const key of Object.keys(patch)) if (!known.has(key)) bad(`Unknown setting: ${key}`)
  const fields: string[] = []
  const seller = () => child(raw, 'seller')

  if (patch.displayName !== undefined) {
    if (typeof patch.displayName !== 'string' || patch.displayName.trim().length > 64) bad('displayName must be text of at most 64 characters')
    const identity = child(raw, 'identity')
    const name = patch.displayName.trim()
    if (name) identity.displayName = name
    else delete identity.displayName
    fields.push('displayName')
  }
  if (patch.maxConcurrentBuyers !== undefined) {
    seller().maxConcurrentBuyers = int(patch.maxConcurrentBuyers, 'maxConcurrentBuyers', 1)
    fields.push('maxConcurrentBuyers')
  }
  if (patch.healthCheck !== undefined) {
    const input = obj(patch.healthCheck, 'healthCheck')
    const out = child(seller(), 'healthCheck')
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') bad('healthCheck.enabled must be true or false')
      out.enabled = input.enabled
    }
    if (input.intervalMs !== undefined) out.intervalMs = int(input.intervalMs, 'healthCheck.intervalMs', 60_000)
    if (input.failureThreshold !== undefined) out.failureThreshold = int(input.failureThreshold, 'healthCheck.failureThreshold', 1)
    fields.push('healthCheck')
  }
  if (patch.gasCheck !== undefined) {
    const input = obj(patch.gasCheck, 'gasCheck')
    const out = child(seller(), 'gasCheck')
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') bad('gasCheck.enabled must be true or false')
      out.enabled = input.enabled
    }
    if (input.minBalanceEth !== undefined) {
      if (typeof input.minBalanceEth !== 'number' || !Number.isFinite(input.minBalanceEth) || input.minBalanceEth < 0) bad('gasCheck.minBalanceEth must be an ETH amount of 0 or more')
      out.minBalanceEth = input.minBalanceEth
    }
    fields.push('gasCheck')
  }
  if (patch.gasRefuel !== undefined) {
    const input = obj(patch.gasRefuel, 'gasRefuel')
    const out = child(seller(), 'gasRefuel')
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') bad('gasRefuel.enabled must be true or false')
      out.enabled = input.enabled
    }
    const amount = (key: 'triggerBalanceEth' | 'swapUsdc' | 'maxUsdcPerDay', min: number, what: string) => {
      const value = input[key]
      if (value === undefined) return
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value < min) bad(`gasRefuel.${key} must be ${what}`)
      out[key] = value
    }
    amount('triggerBalanceEth', 0, 'an ETH amount above 0')
    amount('swapUsdc', 1, 'at least 1 USDC')
    amount('maxUsdcPerDay', 0, 'a USDC amount above 0')
    fields.push('gasRefuel')
  }
  if (patch.freeTier !== undefined) {
    const input = obj(patch.freeTier, 'freeTier')
    const out = child(seller(), 'freeTier')
    applyFreeTierPatch(out, input, 'freeTier')
    // Without a limit there is no seller-wide program: clearing both removes it, staked tiers and all.
    // A patch that sets other fields without any limit is left for the config check to refuse.
    const clearedLimit = input.maxRequestsPerAddress === null || input.maxRequestsPerIp === null
    if (Object.keys(out).length === 0 || (clearedLimit && out.maxRequestsPerAddress === undefined && out.maxRequestsPerIp === undefined)) delete seller().freeTier
    fields.push('freeTier')
  }
  if (patch.restrictedCountries !== undefined) {
    if (patch.restrictedCountries === null) delete seller().restrictedCountries
    else {
      if (!Array.isArray(patch.restrictedCountries)) bad('restrictedCountries must be a list of country codes')
      const codes = patch.restrictedCountries.map((code) => (typeof code === 'string' ? code.trim().toUpperCase() : ''))
      for (const code of codes) if (!/^[A-Z]{2}$/.test(code)) bad(`restrictedCountries: "${code}" is not a two-letter ISO country code`)
      seller().restrictedCountries = [...new Set(codes)]
    }
    fields.push('restrictedCountries')
  }
  if (patch.pricing !== undefined) {
    if (!Array.isArray(patch.pricing)) bad('pricing must be a list')
    const providers = (seller().providers ?? {}) as Record<string, { services?: Record<string, JsonObject> }>
    for (const entry of patch.pricing) {
      const item = obj(entry, 'pricing entry')
      // Own keys only: a service named like an Object.prototype member (`__proto__`) is not a service.
      const provider = typeof item.provider === 'string' && Object.hasOwn(providers, item.provider) ? providers[item.provider] : undefined
      const services = provider?.services
      const service = typeof item.service === 'string' && services && Object.hasOwn(services, item.service) ? services[item.service] : undefined
      if (!service) bad(`pricing: no service ${String(item.service)} under provider ${String(item.provider)} in the config file`)
      const priceKeys = ['inputUsdPerMillion', 'outputUsdPerMillion', 'cachedInputUsdPerMillion'] as const
      if (priceKeys.some((key) => item[key] !== undefined)) {
        const current = (service.pricing && typeof service.pricing === 'object' ? service.pricing : {}) as JsonObject
        const next: JsonObject = { ...current }
        for (const key of priceKeys) {
          if (item[key] === undefined) continue
          if (item[key] === null && key === 'cachedInputUsdPerMillion') delete next[key]
          else next[key] = price(item[key], `${String(item.service)} ${key}`)
        }
        if (next.inputUsdPerMillion === undefined || next.outputUsdPerMillion === undefined) bad(`pricing: ${String(item.service)} needs both input and output prices`)
        service.pricing = next
      }
      if (item.enabled !== undefined) {
        if (typeof item.enabled !== 'boolean') bad(`${String(item.service)} enabled must be true or false`)
        if (item.enabled) delete service.enabled
        else service.enabled = false
        if (!fields.includes('services')) fields.push('services')
      }
      if (item.unitPrices !== undefined) {
        if (!Array.isArray(item.unitPrices)) bad(`${String(item.service)} unitPrices must be a list`)
        const models = (service.unitBillingModels && typeof service.unitBillingModels === 'object' ? service.unitBillingModels : {}) as JsonObject
        for (const entry of item.unitPrices) {
          const change = obj(entry, `${String(item.service)} unit price`)
          const model = typeof change.protocol === 'string' && Object.hasOwn(models, change.protocol) ? models[change.protocol] as JsonObject : undefined
          const components = Array.isArray(model?.components) ? model.components as JsonObject[] : []
          const wanted = JSON.stringify(change.match ?? null)
          // Found by what it bills, not its position, so an edit made elsewhere in the meantime never lands on another component.
          const component = components.find((candidate) => candidate.unit === change.unit && JSON.stringify(candidate.match ?? null) === wanted)
          if (!component) bad(`${String(item.service)}: no ${String(change.unit)} price${change.match ? ` for ${wanted}` : ''} under ${String(change.protocol)} in the config file`)
          component.priceUsd = price(change.priceUsd, `${String(item.service)} ${String(change.unit)} price`)
        }
        if (!fields.includes('pricing')) fields.push('pricing')
      }
      if (item.freeTier !== undefined) {
        // One program per model id: every provider offering this id gets the same edit, so they stay identical.
        const sameId = Object.values(providers).flatMap((entry) => Object.entries(entry.services ?? {}))
          .filter(([id, other]) => id === String(item.service) && (other === service || other.freeTier !== undefined))
          .map(([, other]) => other)
        if (item.freeTier === null) for (const target of sameId) delete target.freeTier
        else {
          // The program the seller applies now (any provider's), edited once and copied to each.
          // A new program starts empty: the base limits must be given (the config check says which).
          const current = sameId.map((target) => target.freeTier).find((program) => program && typeof program === 'object') as JsonObject | undefined
          const program: JsonObject = structuredClone(current ?? {})
          applyFreeTierPatch(program, obj(item.freeTier, `${String(item.service)} freeTier`), `${String(item.service)} freeTier`)
          for (const target of sameId) {
            if (Object.keys(program).length === 0) delete target.freeTier
            else target.freeTier = structuredClone(program)
          }
        }
        if (!fields.includes('freeTier')) fields.push('freeTier')
      }
    }
    if (!fields.includes('pricing')) fields.push('pricing')
  }
  if (patch.removeServices !== undefined) {
    if (!Array.isArray(patch.removeServices)) bad('removeServices must be a list')
    const providers = (seller().providers ?? {}) as Record<string, { services?: Record<string, JsonObject> }>
    for (const entry of patch.removeServices) {
      const item = obj(entry, 'removeServices entry')
      const services = typeof item.provider === 'string' && Object.hasOwn(providers, item.provider) ? providers[item.provider]!.services : undefined
      if (!services || typeof item.service !== 'string' || !Object.hasOwn(services, item.service)) bad(`removeServices: no service ${String(item.service)} under provider ${String(item.provider)} in the config file`)
      // A provider with no models stops the whole seller from starting: its last one is turned off instead.
      if (Object.keys(services).length === 1) bad(`removeServices: ${item.service} is the last model of ${String(item.provider)}; turn it off instead (the provider is then not started)`)
      delete services[item.service]
      // Backup upstreams that list it serve it no more; one that served only it goes too (an empty list is invalid).
      const provider = providers[item.provider as string] as { fallbackUpstreams?: Array<{ services?: Record<string, unknown> }> }
      if (Array.isArray(provider.fallbackUpstreams)) {
        provider.fallbackUpstreams = provider.fallbackUpstreams.filter((fallback) => {
          if (!fallback?.services || typeof fallback.services !== 'object' || !Object.hasOwn(fallback.services, item.service as string)) return true
          delete fallback.services[item.service as string]
          return Object.keys(fallback.services).length > 0
        })
        if (provider.fallbackUpstreams.length === 0) delete provider.fallbackUpstreams
      }
    }
    fields.push('services')
  }
  if (patch.addServices !== undefined) {
    if (!Array.isArray(patch.addServices)) bad('addServices must be a list')
    const providers = (seller().providers ?? {}) as Record<string, { services?: Record<string, JsonObject> }>
    for (const entry of patch.addServices) {
      const item = obj(entry, 'addServices entry')
      const provider = typeof item.provider === 'string' && Object.hasOwn(providers, item.provider) ? providers[item.provider]! : undefined
      if (!provider) bad(`addServices: no provider ${String(item.provider)} in the config file`)
      const id = typeof item.service === 'string' ? item.service.trim() : ''
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) bad(`addServices: "${id}" is not a model id (letters, digits and . _ : / @ + -, up to 128)`)
      const services = (provider.services ??= {})
      if (Object.hasOwn(services, id)) bad(`addServices: ${id} is already offered under ${String(item.provider)}`)
      if (Object.values(services).some((service) => service.unitBillingModels !== undefined)) bad(`addServices: ${String(item.provider)} bills per image or video; add its models in the config file, with their capabilities and unit prices`)
      if (singleServicePlugin((provider as { plugin?: unknown }).plugin)) bad(`addServices: ${String(item.provider)} is a routing provider that offers exactly one service`)
      const added: JsonObject = {}
      if (item.upstreamModel !== undefined && item.upstreamModel !== null && item.upstreamModel !== '') {
        if (typeof item.upstreamModel !== 'string' || item.upstreamModel.trim().length > 200) bad(`addServices: ${id} upstreamModel must be text`)
        if (item.upstreamModel.trim() !== id) added.upstreamModel = item.upstreamModel.trim()
      }
      if (item.categories !== undefined) {
        if (!Array.isArray(item.categories) || item.categories.some((category) => typeof category !== 'string')) bad(`addServices: ${id} categories must be a list of words`)
        const categories = [...new Set((item.categories as string[]).map((category) => category.trim().toLowerCase()).filter(Boolean))]
        if (categories.length > 0) added.categories = categories
      }
      const pricing: JsonObject = {
        inputUsdPerMillion: price(item.inputUsdPerMillion, `${id} inputUsdPerMillion`),
        outputUsdPerMillion: price(item.outputUsdPerMillion, `${id} outputUsdPerMillion`),
      }
      if (item.cachedInputUsdPerMillion !== undefined && item.cachedInputUsdPerMillion !== null) pricing.cachedInputUsdPerMillion = price(item.cachedInputUsdPerMillion, `${id} cachedInputUsdPerMillion`)
      added.pricing = pricing
      services[id] = added
    }
    fields.push('services')
  }
  if (fields.includes('services')) {
    // The seller does not start without a model to offer, and with it goes this dashboard: one stays on.
    const providers = (seller().providers ?? {}) as Record<string, { services?: Record<string, JsonObject> }>
    const started = startedProviders?.filter((name) => Object.hasOwn(providers, name)) ?? []
    const counted = started.length > 0 ? started.map((name) => providers[name]!) : Object.values(providers)
    const offered = counted.some((provider) => Object.values(provider.services ?? {}).some((service) => service.enabled !== false))
    if (!offered) bad(`At least one model must stay offered${started.length > 0 ? ` by the providers this seller starts (${started.join(', ')})` : ''}: the seller does not start without one (and this dashboard with it)`)
  }
  return fields
}

/** One free-tier program's edit, in place; deeper checks (limits needed, tier order, size) are the config validation's. */
function applyFreeTierPatch(out: JsonObject, input: JsonObject, field: string): void {
  for (const key of Object.keys(input)) {
    if (!['maxRequestsPerAddress', 'maxRequestsPerIp', 'windowMs', 'stakersOnly', 'stakeTiers'].includes(key)) bad(`${field}: unknown field ${key}`)
  }
  for (const [key, min] of [['maxRequestsPerAddress', 1], ['maxRequestsPerIp', 1], ['windowMs', 1_000]] as const) {
    if (input[key] === undefined) continue
    if (input[key] === null) delete out[key]
    else out[key] = int(input[key], `${field}.${key}`, min)
  }
  if (input.stakersOnly !== undefined) {
    if (typeof input.stakersOnly !== 'boolean') bad(`${field}.stakersOnly must be true or false`)
    if (input.stakersOnly) out.stakersOnly = true
    else delete out.stakersOnly
  }
  if (input.stakeTiers !== undefined) {
    if (input.stakeTiers === null) delete out.stakeTiers
    else {
      if (!Array.isArray(input.stakeTiers)) bad(`${field}.stakeTiers must be a list`)
      out.stakeTiers = input.stakeTiers.map((entry, index) => {
        const tier = obj(entry, `${field}.stakeTiers[${index}]`)
        const minPower = int(tier.minPower, `${field}.stakeTiers[${index}].minPower`, 1)
        const multiplier = tier.multiplier === 'unlimited' ? 'unlimited' : int(tier.multiplier, `${field}.stakeTiers[${index}].multiplier`, 1)
        return { minPower, multiplier }
      })
    }
  }
}

/** Saves a settings patch (see `patchSellerConfig`); applies when the seller restarts. */
export async function updateSellerSettings(configPath: string, dataDir: string, body: unknown): Promise<{ settings: SellerSettings; fields: string[] }> {
  let fields: string[] = []
  // The providers the seller starts with (its selection, from its state file), so a model stays on among them.
  const state = await readDaemonState(dataDir)
  const selected = state?.['selectedProviders']
  const pricing = state?.['providerPricing']
  const started = Array.isArray(selected) ? selected.filter((name): name is string => typeof name === 'string')
    : pricing && typeof pricing === 'object' ? Object.keys(pricing) : null
  await patchSellerConfig(configPath, dataDir, (raw) => { fields = applySellerSettingsPatch(raw, body, started) })
  return { settings: await readSellerSettings(configPath, dataDir), fields }
}

// ── Alerts ───────────────────────────────────────────────────────────────

/** Alerts are saved in the data dir, so they stay editable when config.json is read-only. */
async function dataDirWritable(dataDir: string): Promise<{ writable: boolean; reason: string | null }> {
  try {
    await access(dataDir, constants.W_OK)
    return { writable: true, reason: null }
  } catch {
    return { writable: false, reason: `The seller's data directory ${dataDir} is not writable here, so settings cannot be saved there.` }
  }
}

export async function readSellerAlertSettings(configPath: string, dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<SellerAlertSettings> {
  const fromFile = readAlertsConfig(configPath)
  const overrides = readAlertOverrides(dataDir)
  const config = applyAlertOverrides(fromFile, overrides)
  const secrets = readAlertSecrets(dataDir)
  const resolved = resolveAlerts(config, secrets, env)
  const tokenEnv = config.telegram?.botTokenEnv || DEFAULT_TELEGRAM_TOKEN_ENV
  // This process (dashboard, gateway) may not share the seller's environment:
  // a token set only there shows through the running seller's own report.
  const fromEnv = Boolean(env[tokenEnv]?.trim()) || (!secrets.telegramBotToken && await runningSellerSendsTelegram(dataDir))
  const access = await dataDirWritable(dataDir)
  return {
    writable: access.writable,
    readOnlyReason: access.reason,
    telegram: {
      chatId: config.telegram?.chatId || null,
      botTokenEnv: tokenEnv,
      tokenSet: fromEnv || Boolean(secrets.telegramBotToken),
      tokenSource: fromEnv ? 'env' : secrets.telegramBotToken ? 'file' : null,
      active: resolved.telegram !== null || (fromEnv && Boolean(config.telegram?.chatId)),
    },
    webhook: {
      set: resolved.webhookUrl !== null,
      host: webhookHost(resolved.webhookUrl),
      source: secrets.webhookUrl ? 'file' : config.webhook?.url ? 'config' : null,
    },
    idleMinutes: config.idleMinutes ?? null,
    cooldownMinutes: config.cooldownMinutes ?? null,
    lowBalanceUsd: config.lowBalanceUsd ?? null,
    minSeverity: config.minSeverity ?? null,
  }
}

/** Whether the running seller reports Telegram among the channels it sends to (its state file is fresh). */
export async function runningSellerSendsTelegram(dataDir: string): Promise<boolean> {
  const status = await readSellerStatus(dataDir, '')
  return status.available && status.running && Boolean(status.alerts?.channels.includes('telegram'))
}

const TELEGRAM_TOKEN = /^\d{3,}:[A-Za-z0-9_-]{20,}$/

function webhookUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    bad('The webhook URL is not a valid URL')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) bad('The webhook URL must use https (http only for localhost)')
  return url.toString()
}

/**
 * Saves alert settings, all in the seller's data dir: the bot token and webhook
 * URL (which often carries a token) to `secrets/seller-alerts.json`, the rest to
 * `seller-alerts.json`, layered over `seller.alerts` in config.json. config.json
 * is never written, so this works when it is read-only. A running seller picks
 * the change up within seconds. Returns what changed, secrets as set/cleared only.
 */
export async function updateSellerAlerts(dataDir: string, body: unknown): Promise<Record<string, string>> {
  const patch = obj(body ?? {}, 'The request body') as SellerAlertsPatch & JsonObject
  const known = new Set(['telegramChatId', 'telegramBotToken', 'webhookUrl', 'idleMinutes', 'cooldownMinutes', 'lowBalanceUsd', 'minSeverity'])
  for (const key of Object.keys(patch)) if (!known.has(key)) bad(`Unknown alert setting: ${key}`)
  const access = await dataDirWritable(dataDir)
  if (!access.writable) throw new ConsoleError(409, 'data_dir_read_only', access.reason!)
  const changed: Record<string, string> = {}
  const secrets: { telegramBotToken?: string | null; webhookUrl?: string | null } = {}
  const overrides: AlertOverrides = {}

  if (patch.telegramBotToken !== undefined) {
    if (patch.telegramBotToken !== null && (typeof patch.telegramBotToken !== 'string' || !TELEGRAM_TOKEN.test(patch.telegramBotToken.trim()))) bad('That does not look like a Telegram bot token (123456:ABC…, from @BotFather)')
    secrets.telegramBotToken = patch.telegramBotToken === null ? null : patch.telegramBotToken.trim()
    changed.telegramBotToken = patch.telegramBotToken === null ? 'cleared' : 'set'
  }
  if (patch.webhookUrl !== undefined) {
    if (patch.webhookUrl !== null && typeof patch.webhookUrl !== 'string') bad('webhookUrl must be a URL or null')
    secrets.webhookUrl = patch.webhookUrl === null || patch.webhookUrl.trim() === '' ? null : webhookUrl(patch.webhookUrl)
    // A URL written in config.json by hand would outlive a clear (or a replacement's removal): stop using it.
    overrides.webhookFromConfig = false
    changed.webhookUrl = secrets.webhookUrl === null ? 'cleared' : 'set'
  }
  if (patch.telegramChatId !== undefined) {
    const chatId = patch.telegramChatId === null ? '' : String(patch.telegramChatId).trim()
    if (chatId && !/^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/.test(chatId)) bad('The chat id is a number (negative for groups) or @channelname')
    overrides.telegramChatId = chatId || null
    changed.telegramChatId = chatId ? 'set' : 'cleared'
  }
  for (const [key, min, max] of [['idleMinutes', 1, 10_080], ['cooldownMinutes', 0, 10_080]] as const) {
    if (patch[key] === undefined) continue
    overrides[key] = patch[key] === null ? null : int(patch[key], key, min, max)
    changed[key] = String(patch[key])
  }
  if (patch.lowBalanceUsd !== undefined) {
    if (patch.lowBalanceUsd !== null && (typeof patch.lowBalanceUsd !== 'number' || !Number.isFinite(patch.lowBalanceUsd) || patch.lowBalanceUsd < 0 || patch.lowBalanceUsd > 1_000_000)) bad('lowBalanceUsd must be a USD amount of 0 or more')
    overrides.lowBalanceUsd = patch.lowBalanceUsd
    changed.lowBalanceUsd = String(patch.lowBalanceUsd)
  }
  if (patch.minSeverity !== undefined) {
    if (patch.minSeverity !== null && patch.minSeverity !== 'info' && patch.minSeverity !== 'warning' && patch.minSeverity !== 'critical') bad('minSeverity must be info, warning or critical')
    overrides.minSeverity = patch.minSeverity
    changed.minSeverity = String(patch.minSeverity)
  }
  if (Object.keys(overrides).length > 0) await writeAlertOverrides(dataDir, overrides)
  if (Object.keys(secrets).length > 0) await writeAlertSecrets(dataDir, secrets)
  return changed
}
