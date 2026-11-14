import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { ConfigField, Provider } from '@antseed/node'
import { parseNonNegativeNumber, parseServicePricingJson } from '@antseed/provider-core'
import { loadConfig } from '../../../config/loader.js'
import { resolveEffectiveSellerConfig, type SellerRuntimeOverrides } from '../../../config/effective.js'
import type { AntseedConfig } from '../../../config/types.js'
import { buildSellerPluginRuntimeEnv, mergeSellerRuntimeEnv } from './start.js'

type ProviderPricing = Provider['pricing']

export interface PriceReloadTarget {
  /** Config provider name (`seller.providers.<name>`). */
  name: string
  /** Unwrapped plugin provider; agent wrappers share its `pricing` object. */
  provider: Provider
  configFields: ConfigField[]
  /** Plugin config built from env at startup, before seller runtime env merge. */
  basePluginConfig: Record<string, string>
}

export interface PriceReloadOptions {
  configPath: string
  targets: PriceReloadTarget[]
  runtimeOverrides: SellerRuntimeOverrides
  forcePricingOverride: boolean
  /** Called after new prices were applied (refresh/re-announce metadata). */
  onApplied: () => Promise<void>
  log?: (message: string) => void
  warn?: (message: string) => void
  debounceMs?: number
  pollMs?: number
}

const INPUT = 'ANTSEED_INPUT_USD_PER_MILLION'
const OUTPUT = 'ANTSEED_OUTPUT_USD_PER_MILLION'
const CACHED = 'ANTSEED_CACHED_INPUT_USD_PER_MILLION'
const SERVICES = 'ANTSEED_SERVICE_PRICING_JSON'

/**
 * Resolve token pricing for every target exactly the way `seller start` does:
 * effective config (env + CLI overrides) -> plugin runtime env -> plugin parsers.
 * Throws without side effects if anything is invalid.
 */
export function resolveReloadedPricing(
  config: AntseedConfig,
  options: Pick<PriceReloadOptions, 'targets' | 'runtimeOverrides' | 'forcePricingOverride'>,
): ProviderPricing[] {
  const effective = resolveEffectiveSellerConfig({ config, sellerOverrides: options.runtimeOverrides })
  return options.targets.map(({ name, provider, configFields, basePluginConfig }) => {
    if (!effective.providers[name]) {
      throw new Error(`provider "${name}" is no longer configured (provider changes need a restart)`)
    }
    const env = mergeSellerRuntimeEnv(basePluginConfig, buildSellerPluginRuntimeEnv(effective, name), {
      forcePricingOverride: options.forcePricingOverride,
    })
    const field = (key: string) => configFields.find((candidate) => candidate.key === key)
    const number = (key: string, current: number) => {
      const spec = field(key)
      return spec ? parseNonNegativeNumber(env[key], key, Number(spec.default ?? 0)) : current
    }
    const current = provider.pricing
    const cached = field(CACHED)
      ? (env[CACHED] ? parseNonNegativeNumber(env[CACHED], CACHED, 0) : undefined)
      : current.defaults.cachedInputUsdPerMillion
    const services = field(SERVICES) ? parseServicePricingJson(env[SERVICES]) : current.services
    return {
      defaults: {
        inputUsdPerMillion: number(INPUT, current.defaults.inputUsdPerMillion),
        outputUsdPerMillion: number(OUTPUT, current.defaults.outputUsdPerMillion),
        ...(cached != null ? { cachedInputUsdPerMillion: cached } : {}),
      },
      ...(services ? { services } : {}),
    }
  })
}

/**
 * Swap in new pricing. The shared `pricing` object is updated in place (agent
 * wrappers only expose it through a getter), but its leaf objects are replaced,
 * never mutated, so channel snapshots and in-flight requests keep old rates.
 */
export function applyReloadedPricing(targets: PriceReloadTarget[], next: ProviderPricing[]): boolean {
  let changed = false
  targets.forEach(({ provider }, index) => {
    const pricing = provider.pricing
    const update = next[index]!
    if (JSON.stringify(pricing) === JSON.stringify(update)) return
    changed = true
    pricing.defaults = update.defaults
    if (update.services) pricing.services = update.services
    else delete pricing.services
  })
  return changed
}

export function startSellerPriceReload(options: PriceReloadOptions): { reload: () => Promise<void>; stop: () => void } {
  const configPath = resolve(options.configPath)
  const log = options.log ?? console.log
  const warn = options.warn ?? console.warn
  let stopped = false
  let running: Promise<void> | null = null
  let rerun = false
  let lastRaw: string | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const reloadOnce = async (): Promise<void> => {
    let raw: string
    try {
      raw = await readFile(configPath, 'utf-8')
    } catch (err) {
      raw = `<unreadable:${(err as NodeJS.ErrnoException).code ?? 'error'}>`
      if (raw !== lastRaw && !stopped) warn(`Price reload skipped: cannot read ${configPath}; keeping current prices.`)
      lastRaw = raw
      return
    }
    if (raw === lastRaw || stopped) return
    lastRaw = raw
    let next: ProviderPricing[]
    try {
      JSON.parse(raw)
      const config = await loadConfig(configPath)
      next = resolveReloadedPricing(config, options)
    } catch (err) {
      if (!stopped) warn(`Price reload skipped: invalid config (${(err as Error).message}); keeping current prices.`)
      return
    }
    if (stopped || !applyReloadedPricing(options.targets, next)) return
    for (const { name, provider } of options.targets) {
      const d = provider.pricing.defaults
      log(`Reloaded ${name} pricing (USD/1M): input=${d.inputUsdPerMillion}, output=${d.outputUsdPerMillion}${d.cachedInputUsdPerMillion != null ? `, cached=${d.cachedInputUsdPerMillion}` : ''}`)
    }
    await options.onApplied()
  }

  const reload = async (): Promise<void> => {
    if (stopped) return
    if (running) {
      rerun = true
      return running
    }
    running = (async () => {
      try {
        do {
          rerun = false
          await reloadOnce()
        } while (rerun && !stopped)
      } catch (err) {
        warn(`Price reload failed: ${(err as Error).message}`)
      } finally {
        running = null
      }
    })()
    return running
  }

  const schedule = () => {
    if (stopped) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void reload()
    }, options.debounceMs ?? 250)
  }

  // Catch edits made between startup config load and now (no-op otherwise).
  schedule()

  // Watch the directory, not the file: atomic saves replace the inode.
  let watcher: FSWatcher | null = null
  try {
    const fileName = basename(configPath)
    watcher = watch(dirname(configPath), (_event, changed) => {
      if (!changed || changed.toString() === fileName) schedule()
    })
    watcher.on('error', () => { watcher?.close(); watcher = null })
  } catch {
    watcher = null
  }
  const poll = setInterval(schedule, options.pollMs ?? 30_000)
  poll.unref?.()

  return {
    reload,
    stop: () => {
      stopped = true
      watcher?.close()
      watcher = null
      clearInterval(poll)
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = null
    },
  }
}
