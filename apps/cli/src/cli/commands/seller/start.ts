import type { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import { getGlobalOptions } from '../types.js'
import pkg from '../../../../package.json' with { type: 'json' }
import { watchForUpdates } from '../../../update/watch.js'
import { resolveConfigPath } from '../../../config/loader.js'
import { configOverridesPath, loadSellerConfig } from '../../../config/overrides.js'
import { DEFAULT_RESTRICTED_COUNTRIES } from '../../../config/defaults.js'
import {
  AntseedNode,
  ModelHealthChecker,
  GasHealthMonitor,
  GasAutoRefueler,
  UsdcEthSwapClient,
  usdcEthSwapDeployment,
  CONNECTION_CAPABILITY_MODEL_HEALTH_V1,
  DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  DEFAULT_HEALTH_CHECK_FAILURE_THRESHOLD,
  DEFAULT_GAS_CHECK_INTERVAL_MS,
  DEFAULT_MIN_GAS_BALANCE_WEI,
  SellerFreeTierLimiter,
  formatEther,
  type Provider,
  type Prover,
  type ConfigField,
  resolveChainConfig,
  loadOrCreateIdentity,
} from '@antseed/node'
import type { PaymentConfig } from '@antseed/node/payments'
import { checkSellerReadiness, DEFAULT_MIN_SETTLE_DELTA_STR } from '@antseed/node/payments'
import {
  ANTSEED_BASE_RPC_URL_ENV,
  createIdentityClient,
  createStakingClient,
  requireCryptoConfig,
  resolveBaseRpcUrlOverride,
} from '../../payment-utils.js'
import type { AntseedConfig, SellerCLIConfig, SellerProviderConfig } from '../../../config/types.js'
import { ANTSEED_VERIFIER_SDKS_ENV, buildVerifierCapabilities, normalizeVerifierIds } from '../../../plugins/verifier.js'
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import { isRestarting, setupShutdownHandler, shutdownForRestart } from '../../shutdown.js'
import { loadProviderPlugin, loadProverPlugin, buildPluginConfig, getPackageVersions } from '../../../plugins/loader.js'
import { ensurePluginsUpToDate } from '../../../plugins/drift.js'
import { dropDisabledServices, pricedSellerServices, resolveEffectiveSellerConfig, resolveSellerFreeTier, type SellerRuntimeOverrides } from '../../../config/effective.js'
import { ensureDerivedIdentityDisplayName } from '../../../config/identity-display-name.js'
import { AntAgentProvider, loadAntAgent, type AntAgentDefinition } from '@antseed/ant-agent'
import { resolvePluginPackage } from '../../../plugins/registry.js'
import { startupReachabilityWarning } from './reachability.js'
import { initializeProvider } from './provider-init.js'
import { sharedChainProvider } from '../../../proxy/chain-rpc.js'
import { rpcUsage, withRpcSource } from '../../../proxy/rpc-sources.js'
import { DEFAULT_LOW_BALANCE_USD, SellerAlerts } from '../../../seller-alerts/alerts.js'
import { UpstreamAlerts } from '../../../seller-alerts/upstream-alerts.js'
import { ethToWei } from './gas.js'
import { gasRefuelState, loadGasRefuelHistory, resolveGasRefuelSettings, saveGasRefuelHistory } from './gas-refuel.js'
import { startIdleWatch, uncleanExitEvent, waitAtMost } from '../../../seller-alerts/lifecycle.js'
import { startSellerDashboard, type SellerDashboardServer } from '../../../seller-monitor/dashboard-server.js'
import { previousDashboardPort, previousDashboardToken, removeDashboardLink, writeDashboardLink } from '../../../seller-monitor/dashboard-link.js'
import { DEFAULT_SELLER_DASHBOARD_PORT } from './dashboard.js'
import { patchSellerConfig } from '../../../seller-monitor/settings.js'

/** How long shutdown waits, after channels are finalized, for a gas refuel swap already sent to be mined and recorded. */
const GAS_REFUEL_SHUTDOWN_WAIT_MS = 20_000

function getStateFile(dataDir: string): string {
  return join(dataDir, 'daemon.state.json')
}

/** The gas monitor's last reading for daemon.state.json, in ETH (bigint is not JSON). */
export function gasHealthState(
  monitor: Pick<GasHealthMonitor, 'getSnapshot'> | null,
  refueler: Pick<GasAutoRefueler, 'getSnapshot'> | null = null,
) {
  if (!monitor) return null
  const snapshot = monitor.getSnapshot()
  return {
    address: snapshot.address,
    depleted: snapshot.depleted,
    balanceEth: snapshot.lastBalanceWei === null ? null : Number(formatEther(snapshot.lastBalanceWei)),
    minBalanceEth: Number(formatEther(snapshot.minBalanceWei)),
    lastCheckedAt: snapshot.lastCheckedAt,
    refuel: gasRefuelState(refueler),
  }
}

export function selectSellerProviderNames(
  sellerConfig: SellerCLIConfig,
  rawNames?: string,
): { selected: string[]; unknown: string[] } {
  const configured = Object.keys(sellerConfig.providers)
  const selected = typeof rawNames === 'string' && rawNames.trim().length > 0
    ? rawNames.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
    : configured
  const unknown = selected.filter((name) => !sellerConfig.providers[name])
  return { selected, unknown }
}

function parseOptionalBoolEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

const PUBLIC_BASE_RPC_HOSTS = new Set([
  'base.gateway.tenderly.co',
  'base-public.nodies.app',
  'base.publicnode.com',
  'base-rpc.publicnode.com',
  'base.drpc.org',
  'base.llamarpc.com',
  'mainnet.base.org',
  'sepolia.base.org',
])

export function isPublicRpcUrl(rpcUrl: string): boolean {
  try {
    const host = new URL(rpcUrl).hostname.toLowerCase()
    return PUBLIC_BASE_RPC_HOSTS.has(host)
  } catch {
    return false
  }
}

/**
 * Gate `antseed seller start` on required prerequisites:
 *   1. At least one service is configured for the selected provider.
 *   2. (When payments are enabled) seller is registered on-chain and staked.
 * Runtime pricing overrides that would be silently ignored (because the
 * providers map is empty) are also flagged as a hard error here.
 *
 * On failure: print a clear list of what's missing with the exact command(s)
 * to fix each one, then throw. Callers should catch and `process.exit(1)`.
 */
export async function assertSellerPrerequisites(input: {
  dataDir: string
  config: AntseedConfig
  effectiveSeller: SellerCLIConfig
  providerNames: string[]
  paymentsEnabled: boolean
  runtimePricingOverride: boolean
  skipChainChecks: boolean
  baseRpcUrlOverride?: string
}): Promise<void> {
  const {
    dataDir,
    config,
    effectiveSeller,
    providerNames,
    paymentsEnabled,
    runtimePricingOverride,
    skipChainChecks,
    baseRpcUrlOverride,
  } = input

  const failures: Array<{ title: string; detail: string; command?: string }> = []

  // 1. Provider has at least one service configured.
  for (const providerName of providerNames) {
    const providerCfg = effectiveSeller.providers[providerName]
    const serviceCount = providerCfg ? Object.keys(providerCfg.services).length : 0
    if (serviceCount === 0) {
      failures.push({
        title: `No services configured for provider "${providerName}"`,
        detail: 'A seller must announce at least one service. Add one with:',
        command: `antseed config seller add-service ${providerName} <serviceId> --input <usd> --output <usd>`,
      })
    }
  }

  // 2. Runtime pricing override was supplied but would silently no-op because
  // no providers are configured. This is the Greptile P2 flag from PR #275.
  if (runtimePricingOverride && Object.keys(effectiveSeller.providers).length === 0) {
    failures.push({
      title: 'Pricing override has nothing to apply to',
      detail: `--input-usd-per-million / --output-usd-per-million (or ANTSEED_SELLER_*_USD_PER_MILLION env) were supplied, but no providers are configured in seller.providers. The override would silently no-op.`,
      command: `antseed config seller add-service ${providerNames[0] ?? '<provider>'} <serviceId> --input <usd> --output <usd>`,
    })
  }

  // 3. On-chain readiness — only when payments are actually on.
  if (paymentsEnabled && config.payments.crypto && !skipChainChecks) {
    try {
      const identity = await loadOrCreateIdentity(dataDir)
      const identityClient = createIdentityClient(config, { rpcUrl: baseRpcUrlOverride })
      const stakingClient = createStakingClient(config, { rpcUrl: baseRpcUrlOverride })
      const sellerContract = config.payments.sellerContract?.address
      const checks = await checkSellerReadiness(identity, identityClient, stakingClient, sellerContract)
      for (const check of checks) {
        if (!check.passed) {
          failures.push({
            title: check.name,
            detail: check.message,
            command: check.command,
          })
        }
      }
    } catch (err) {
      // If we can't even reach the chain, surface the error rather than
      // silently skipping — that's what broke testnet-together earlier today.
      failures.push({
        title: 'On-chain readiness check failed',
        detail: `Could not query the configured chain (${(err as Error).message}). Set payments.crypto.rpcUrl or pass --skip-prereq-check to bypass.`,
      })
    }
  }

  if (failures.length === 0) return

  console.error(chalk.red('\nCannot start seller node — prerequisites not met:\n'))
  for (const f of failures) {
    console.error(`  ${chalk.red('✗')} ${chalk.bold(f.title)}`)
    console.error(`    ${chalk.dim(f.detail)}`)
    if (f.command) {
      console.error(`    ${chalk.cyan(f.command)}`)
    }
    console.error('')
  }
  console.error(chalk.dim('Run `antseed seller setup` for a guided walkthrough, or pass --skip-prereq-check to bypass all checks (not recommended).'))
  throw new Error('seller prerequisites not met')
}

async function isRpcReachable(rpcUrl: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      }),
      signal: controller.signal,
    })

    if (!response.ok) return false

    const payload = await response.json() as { result?: unknown }
    return typeof payload.result === 'string' && payload.result.startsWith('0x')
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function toUSDCBaseUnits(value: string | undefined, fallbackBaseUnits: string): string {
  if (value === undefined) return fallbackBaseUnits
  const parsed = Number.parseFloat(value.trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackBaseUnits
  return String(Math.round(parsed * 1_000_000))
}

export function parseOptionalPositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function buildSellerRuntimeOverridesFromFlags(options: {
  reserve?: number
  inputUsdPerMillion?: number
  outputUsdPerMillion?: number
}): SellerRuntimeOverrides {
  const overrides: SellerRuntimeOverrides = {}
  if (options.reserve !== undefined) {
    overrides.reserveFloor = options.reserve
  }
  if (options.inputUsdPerMillion !== undefined) {
    overrides.inputUsdPerMillion = options.inputUsdPerMillion
  }
  if (options.outputUsdPerMillion !== undefined) {
    overrides.outputUsdPerMillion = options.outputUsdPerMillion
  }
  return overrides
}

/**
 * Translate the unified `seller.providers[name]` block into the flat
 * `ANTSEED_*` env keys that provider plugins consume. Plugins continue to
 * receive the same shape they always have — the CLI just produces it from
 * config.json instead of having users set env vars by hand.
 */
export function buildSellerPluginRuntimeEnv(
  sellerConfig: SellerCLIConfig,
  providerName: string,
): Record<string, string> {
  const providerCfg = sellerConfig.providers?.[providerName]
  const runtimeEnv: Record<string, string> = {
    ANTSEED_MAX_CONCURRENCY: String(sellerConfig.maxConcurrentBuyers),
  }
  if (!providerCfg) {
    return runtimeEnv
  }

  if (providerCfg.defaults) {
    runtimeEnv['ANTSEED_INPUT_USD_PER_MILLION'] = String(providerCfg.defaults.inputUsdPerMillion)
    runtimeEnv['ANTSEED_OUTPUT_USD_PER_MILLION'] = String(providerCfg.defaults.outputUsdPerMillion)
    if (providerCfg.defaults.cachedInputUsdPerMillion != null) {
      runtimeEnv['ANTSEED_CACHED_INPUT_USD_PER_MILLION'] = String(providerCfg.defaults.cachedInputUsdPerMillion)
    }
  }

  const serviceIds = Object.keys(providerCfg.services)
  if (serviceIds.length > 0) {
    runtimeEnv['ANTSEED_ALLOWED_SERVICES'] = serviceIds.join(',')
  }

  // Per-service pricing: { serviceId -> TokenPricingUsdPerMillion }
  // Note: categories are NOT emitted as an env var. No plugin reads
  // ANTSEED_SERVICE_CATEGORIES_JSON — the CLI writes them directly onto
  // `provider.serviceCategories` in seed.ts below. Keeping categories out of
  // the plugin env avoids dead noise in process.env.
  const servicePricing: Record<string, unknown> = {}
  const serviceAliasMap: Record<string, string> = {}
  const serviceCapabilities: Record<string, unknown> = {}
  const serviceUnitBillingModels: Record<string, unknown> = {}
  for (const [serviceId, serviceCfg] of Object.entries(providerCfg.services)) {
    if (serviceCfg.pricing) {
      servicePricing[serviceId] = serviceCfg.pricing
    }
    if (serviceCfg.upstreamModel && serviceCfg.upstreamModel !== serviceId) {
      serviceAliasMap[serviceId] = serviceCfg.upstreamModel
    }
    if (serviceCfg.capabilities) {
      serviceCapabilities[serviceId] = serviceCfg.capabilities
    }
    if (serviceCfg.unitBillingModels) {
      serviceUnitBillingModels[serviceId] = serviceCfg.unitBillingModels
    }
  }
  if (Object.keys(servicePricing).length > 0) {
    runtimeEnv['ANTSEED_SERVICE_PRICING_JSON'] = JSON.stringify(servicePricing)
  }
  if (Object.keys(serviceAliasMap).length > 0) {
    runtimeEnv['ANTSEED_SERVICE_ALIAS_MAP_JSON'] = JSON.stringify(serviceAliasMap)
  }
  if (Object.keys(serviceCapabilities).length > 0) {
    runtimeEnv['ANTSEED_SERVICE_CAPABILITIES_JSON'] = JSON.stringify(serviceCapabilities)
  }
  if (Object.keys(serviceUnitBillingModels).length > 0) {
    runtimeEnv['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON'] = JSON.stringify(serviceUnitBillingModels)
  }
  const pluginPackage = resolvePluginPackage(providerCfg.plugin)
  const envPrefix = pluginPackage === '@antseed/provider-local-llm'
    ? 'LOCAL_LLM'
    : pluginPackage === '@antseed/provider-typesafe'
      ? 'TYPESAFE'
      : pluginPackage === '@antseed/provider-venice-video' ? 'VENICE_VIDEO'
      : pluginPackage === '@antseed/provider-fal-video' ? 'FAL_VIDEO'
      : pluginPackage === '@antseed/provider-irp-router' ? 'IRP_ROUTER'
      : 'OPENAI'
  if (providerCfg.baseUrl) {
    runtimeEnv[`${envPrefix}_BASE_URL`] = providerCfg.baseUrl
  }
  if (providerCfg.pathRewrite && Object.keys(providerCfg.pathRewrite).length > 0) {
    runtimeEnv['OPENAI_PATH_REWRITE_JSON'] = JSON.stringify(providerCfg.pathRewrite)
  }
  if (providerCfg.apiKeyEnv) {
    const apiKey = process.env[providerCfg.apiKeyEnv]
    if (apiKey) {
      runtimeEnv[`${envPrefix}_API_KEY`] = apiKey
    }
  }
  if (providerCfg.fallbackUpstreams && providerCfg.fallbackUpstreams.length > 0) {
    runtimeEnv['ANTSEED_FALLBACK_UPSTREAMS_JSON'] = JSON.stringify(
      providerCfg.fallbackUpstreams.map((fallback, index) => {
        let apiKey: string | undefined
        if (fallback.apiKeyEnv) {
          apiKey = process.env[fallback.apiKeyEnv]
          if (!apiKey) {
            throw new Error(`fallbackUpstreams[${index}] of provider "${providerName}" reads its API key from ${fallback.apiKeyEnv}, which is not set`)
          }
        }
        const serviceAliasMap = Object.fromEntries(
          Object.entries(fallback.services ?? {})
            .filter(([, service]) => service.upstreamModel)
            .map(([serviceId, service]) => [serviceId, service.upstreamModel]),
        )
        return {
          baseUrl: fallback.baseUrl,
          ...(apiKey ? { apiKey } : {}),
          ...(fallback.services ? { services: Object.keys(fallback.services) } : {}),
          ...(Object.keys(serviceAliasMap).length > 0 ? { serviceAliasMap } : {}),
          ...(fallback.pathRewrite ? { pathRewrite: fallback.pathRewrite } : {}),
        }
      }),
    )
  }

  return runtimeEnv
}

export function getUnsupportedFallbackUpstreamsWarning(
  providerName: string,
  providerConfig: SellerProviderConfig,
  configFields: ConfigField[],
): string | undefined {
  if (!providerConfig.fallbackUpstreams?.length) return undefined
  if (configFields.some((field) => field.key === 'ANTSEED_FALLBACK_UPSTREAMS_JSON')) {
    return undefined
  }
  return `Provider "${providerName}" (${providerConfig.plugin}) ignores fallbackUpstreams because its plugin does not support them.`
}

export function getUnsupportedUnitBillingWarning(
  providerName: string,
  providerConfig: SellerProviderConfig,
  configFields: ConfigField[],
): string | undefined {
  const configuredServices = Object.entries(providerConfig.services)
    .filter(([, service]) => service.unitBillingModels !== undefined)
    .map(([serviceId]) => serviceId)
  if (configuredServices.length === 0) return undefined
  if (configFields.some((field) => field.key === 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON')) {
    return undefined
  }
  return `Provider "${providerName}" (${providerConfig.plugin}) ignores unitBillingModels for service(s): ${configuredServices.join(', ')} because its plugin does not support unit billing.`
}

export function mergeSellerRuntimeEnv(
  baseConfig: Record<string, string>,
  runtimeEnv: Record<string, string>,
  options?: {
    forcePricingOverride?: boolean
  },
): Record<string, string> {
  const merged = { ...baseConfig }
  const forcePricingOverride = options?.forcePricingOverride ?? false
  const pricingKeys = new Set([
    'ANTSEED_INPUT_USD_PER_MILLION',
    'ANTSEED_OUTPUT_USD_PER_MILLION',
  ])

  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (!forcePricingOverride && pricingKeys.has(key) && merged[key] !== undefined) {
      continue
    }
    merged[key] = value
  }

  return merged
}

export function registerSellerStartCommand(sellerCmd: Command): void {
  sellerCmd
    .command('start')
    .description('Start providing AI services on the P2P network')
    .option('--provider <names>', 'start only these providers (comma-separated, default: all configured)')
    .option('-r, --reserve <number>', 'runtime-only reserve floor override (does not write config file)', parseFloat)
    .option('--input-usd-per-million <number>', 'runtime-only input pricing override in USD per 1M tokens', parseFloat)
    .option('--output-usd-per-million <number>', 'runtime-only output pricing override in USD per 1M tokens', parseFloat)
    .option('--dht-port <number>', 'UDP port for DHT (default: 6881)', parseInt)
    .option('--signaling-port <number>', 'TCP port for P2P signaling (default: 6882)', parseInt)
    .option('--min-settle-delta <usdc>', 'minimum unsettled delta (USDC decimal, e.g. 0.002) before idle settle submits a tx')
    .option('--base-rpc-url <url>', `runtime-only Base JSON-RPC URL override (also ${ANTSEED_BASE_RPC_URL_ENV})`)
    .option('--skip-prereq-check', 'skip pre-flight checks (services configured, on-chain registration + stake). Use only for local testing.')
    .option('--no-dashboard', 'do not serve the local seller dashboard (on by default, 127.0.0.1 only)')
    .option('--dashboard-port <port>', `seller dashboard port (default: ${DEFAULT_SELLER_DASHBOARD_PORT}; another free port if taken)`, parseInt)
    .option('--verifiers <ids>', `comma-separated verifier SDK ids this seller supports (first is default; also ${ANTSEED_VERIFIER_SDKS_ENV})`)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(sellerCmd)
      // Settings saved from the dashboard when the config file is read-only apply over it.
      let config: AntseedConfig
      let overriddenSettings: string[] = []
      try {
        ({ config, overridden: overriddenSettings } = await loadSellerConfig(globalOpts.config, globalOpts.dataDir))
      } catch (err) {
        console.error(chalk.red(`Could not load the seller config: ${(err as Error).message}`))
        console.error(chalk.dim(`  Settings saved from the dashboard are in ${configOverridesPath(globalOpts.dataDir)}; fix or delete that file to start from the config file alone.`))
        process.exit(1)
      }
      await ensureDerivedIdentityDisplayName({
        config,
        configPath: globalOpts.config,
        dataDir: globalOpts.dataDir,
        // Only the name, where dashboard saves go (the config file, or its overrides when it is read-only):
        // the config loaded here has the overrides applied, so writing it whole would bake them into the file.
        save: (displayName) => patchSellerConfig(resolveConfigPath(globalOpts.config), globalOpts.dataDir, (raw) => {
          const identity = (raw.identity && typeof raw.identity === 'object' ? raw.identity : (raw.identity = {})) as Record<string, unknown>
          identity.displayName = displayName
        }).catch(() => {}),
      })
      let baseRpcUrlOverride: string | undefined
      try {
        baseRpcUrlOverride = resolveBaseRpcUrlOverride({
          flagValue: options.baseRpcUrl as string | undefined,
        })
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`))
        process.exit(1)
      }

      const runtimeOverrides = buildSellerRuntimeOverridesFromFlags({
        reserve: options.reserve as number | undefined,
        inputUsdPerMillion: options.inputUsdPerMillion as number | undefined,
        outputUsdPerMillion: options.outputUsdPerMillion as number | undefined,
      })
      const forcePricingOverride = runtimeOverrides.inputUsdPerMillion !== undefined
        || runtimeOverrides.outputUsdPerMillion !== undefined
      const effectiveSellerConfig = resolveEffectiveSellerConfig({
        config,
        sellerOverrides: runtimeOverrides,
      })
      const configuredProviderNames = Object.keys(effectiveSellerConfig.providers)
      const providerSelection = selectSellerProviderNames(
        effectiveSellerConfig,
        options.provider as string | undefined,
      )
      // Models turned off from the dashboard (`enabled: false`) are not offered; a provider left with none is not started.
      const disabled = dropDisabledServices(effectiveSellerConfig, providerSelection.selected)
      const selectedProviderNames = providerSelection.selected.filter((name) => !disabled.emptyProviders.includes(name))
      if (disabled.off.length > 0) console.log(chalk.dim(`  models turned off: ${disabled.off.join(', ')}${disabled.emptyProviders.length > 0 ? ` (not starting ${disabled.emptyProviders.join(', ')}: every model is off)` : ''}`))

      if (selectedProviderNames.length === 0) {
        console.error(chalk.red('Error: No seller providers are configured.'))
        console.error(chalk.dim('Run: antseed seller setup  or  antseed config seller add-provider <name> --plugin <plugin>'))
        process.exit(1)
      }

      const unknownProviderNames = providerSelection.unknown
      if (unknownProviderNames.length > 0) {
        console.error(chalk.red(`Unknown provider name(s): ${unknownProviderNames.join(', ')}`))
        console.error(chalk.dim(`Configured providers: ${configuredProviderNames.join(', ') || '(none)'}`))
        process.exit(1)
      }
      const sellerFreeTier = resolveSellerFreeTier(effectiveSellerConfig, selectedProviderNames)

      // Refresh any installed plugin whose pinned `@antseed/*` core deps are
      // older than the versions the CLI itself bundles. Must run BEFORE the
      // first `loadProviderPlugin` import below — once a plugin is `import()`-ed,
      // refreshing it on disk has no effect on the running process.
      // Best-effort: failures here log a warning and let startup continue
      // with the existing (possibly stale) plugins.
      const selectedProviderPackages = selectedProviderNames.map((name) =>
        resolvePluginPackage(effectiveSellerConfig.providers[name]!.plugin),
      )
      await ensurePluginsUpToDate(selectedProviderPackages)

      const providers: Provider[] = []
      for (const providerName of selectedProviderNames) {
        const providerCfg = effectiveSellerConfig.providers[providerName]!
        const packageName = resolvePluginPackage(providerCfg.plugin)
        const spinner = ora(`Loading provider plugin "${packageName}" for "${providerName}"...`).start()
        try {
          const plugin = await loadProviderPlugin(packageName)
          const configFields = plugin.configSchema ?? plugin.configKeys ?? []
          for (const warning of [
            getUnsupportedUnitBillingWarning(providerName, providerCfg, configFields),
            getUnsupportedFallbackUpstreamsWarning(providerName, providerCfg, configFields),
          ]) {
            if (!warning) continue
            spinner.warn(chalk.yellow(warning))
            spinner.start(`Loading provider plugin "${packageName}" for "${providerName}"...`)
          }
          const runtimeEnv = buildSellerPluginRuntimeEnv(effectiveSellerConfig, providerName)
          const basePluginConfig = buildPluginConfig(configFields)
          const pluginConfig = {
            ...mergeSellerRuntimeEnv(basePluginConfig, runtimeEnv, { forcePricingOverride }),
            // Lets plugins keep small state (e.g. pending video download URLs) across restarts.
            ANTSEED_DATA_DIR: globalOpts.dataDir,
          }
          const provider = await plugin.createProvider(pluginConfig)
          if (provider.init) {
            spinner.text = `Validating credentials for "${providerName}"...`
            const ready = await initializeProvider(provider, effectiveSellerConfig.healthCheck?.enabled !== false)
            if (!ready) {
              spinner.warn(chalk.yellow(`Provider "${providerName}" OAuth unavailable; services hidden until health checks recover`))
            }
          }
          providers.push(provider)
          spinner.succeed(chalk.green(`Provider "${providerName}" loaded via ${packageName}`))
        } catch (err) {
          spinner.fail(chalk.red(`Failed to load provider "${providerName}": ${(err as Error).message}`))
          process.exit(1)
        }
      }

      const bootstrapNodes = config.network.bootstrapNodes.length > 0
        ? toBootstrapConfig(parseBootstrapList(config.network.bootstrapNodes))
        : undefined

      const preferredMethod = config.payments.preferredMethod
      const defaultDepositAmountUSDC = process.env['ANTSEED_DEFAULT_DEPOSIT_USDC'] ?? config.payments.crypto?.defaultLockAmountUSDC ?? '1'
      const defaultDepositAmountUSDCBaseUnits = toUSDCBaseUnits(defaultDepositAmountUSDC, '1000000')
      const settlementIdleMsRaw = process.env['ANTSEED_SETTLEMENT_IDLE_MS']
      const settlementIdleMs = settlementIdleMsRaw ? parseInt(settlementIdleMsRaw, 10) : 600_000
      const sellerWalletAddress = process.env['ANTSEED_SELLER_WALLET_ADDRESS']

      let paymentConfig: PaymentConfig | null = null
      let depositRelayAddress: string | undefined
      let sellerPoolsAddress: string | undefined
      if (preferredMethod === 'crypto') {
        const cc = resolveChainConfig({
          chainId: config.payments.crypto?.chainId,
          rpcUrl: baseRpcUrlOverride ?? config.payments.crypto?.rpcUrl,
          fallbackRpcUrls: config.payments.crypto?.fallbackRpcUrls,
          depositsContractAddress: config.payments.crypto?.depositsContractAddress,
          channelsContractAddress: config.payments.crypto?.channelsContractAddress,
          freeUsageContractAddress: config.payments.crypto?.freeUsageContractAddress,
          stakingContractAddress: config.payments.crypto?.stakingContractAddress,
          usdcContractAddress: config.payments.crypto?.usdcContractAddress,
          identityRegistryAddress: config.payments.crypto?.identityRegistryAddress,
          emissionsContractAddress: config.payments.crypto?.emissionsContractAddress,
          depositRelayAddress: config.payments.crypto?.depositRelayAddress,
          sellerPoolsAddress: config.payments.crypto?.sellerPoolsAddress,
        })
        depositRelayAddress = cc.depositRelayAddress
        sellerPoolsAddress = cc.sellerPoolsAddress || undefined
        const defaultLockAmountUSDCBaseUnits = toUSDCBaseUnits(
          config.payments.crypto?.defaultLockAmountUSDC ?? defaultDepositAmountUSDC,
          defaultDepositAmountUSDCBaseUnits,
        )
        const cryptoConfig: NonNullable<PaymentConfig['crypto']> = {
          chainId: cc.chainId,
          rpcUrl: cc.rpcUrl,
          ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
          depositsContractAddress: cc.depositsContractAddress,
          channelsContractAddress: cc.channelsContractAddress,
          ...(cc.freeUsageContractAddress ? { freeUsageContractAddress: cc.freeUsageContractAddress } : {}),
          usdcAddress: cc.usdcContractAddress,
          defaultLockAmountUSDC: defaultLockAmountUSDCBaseUnits,
        }

        paymentConfig = {
          crypto: cryptoConfig,
        }
      }

      const settlementEnv = parseOptionalBoolEnv(process.env['ANTSEED_ENABLE_SETTLEMENT'])
      let paymentsEnabled = settlementEnv ?? paymentConfig !== null
      const cryptoRpcUrl = paymentConfig?.crypto?.rpcUrl

      if (paymentsEnabled && cryptoRpcUrl && settlementEnv !== true) {
        const rpcUp = await isRpcReachable(cryptoRpcUrl)
        if (!rpcUp) {
          paymentsEnabled = false
          console.log(chalk.yellow(`Payments disabled: RPC node unreachable at ${cryptoRpcUrl}`))
          console.log(chalk.dim('Start your chain node or set ANTSEED_ENABLE_SETTLEMENT=true to force-enable payments.'))
        }
      }

      const primaryProviderName = selectedProviderNames[0] ?? providers[0]?.name ?? 'unknown'

      // Pre-flight: refuse to start if the user hasn't added any services,
      // hasn't registered on-chain, or hasn't staked. A clear error is much
      // better than a seller peer that's online but can't take requests.
      try {
        await assertSellerPrerequisites({
          dataDir: globalOpts.dataDir,
          config,
          effectiveSeller: effectiveSellerConfig,
          providerNames: selectedProviderNames,
          paymentsEnabled,
          runtimePricingOverride: forcePricingOverride,
          skipChainChecks: Boolean(options.skipPrereqCheck),
          baseRpcUrlOverride,
        })
      } catch {
        process.exit(1)
      }

      // Write service categories directly from config onto the plugin's
      // Provider object — plugins don't parse this env key themselves.
      for (let index = 0; index < providers.length; index += 1) {
        const provider = providers[index]!
        const providerName = selectedProviderNames[index]!
        const configProviderCfg = effectiveSellerConfig.providers?.[providerName]
        if (configProviderCfg) {
          const categoriesByService: Record<string, string[]> = {}
          for (const [serviceId, svc] of Object.entries(configProviderCfg.services)) {
            if (svc.categories && svc.categories.length > 0) {
              categoriesByService[serviceId] = [...svc.categories]
            }
          }
          if (Object.keys(categoriesByService).length > 0) {
            provider.serviceCategories = categoriesByService
          }
        }
      }

      const versionsByPackage = new Map<string, string>()
      for (const providerName of selectedProviderNames) {
        const providerCfg = effectiveSellerConfig.providers[providerName]!
        for (const [pkg, version] of Object.entries(getPackageVersions(providerCfg.plugin))) {
          versionsByPackage.set(pkg, version)
        }
      }
      if (versionsByPackage.size > 0) {
        console.log(chalk.dim(`Package versions: ${Array.from(versionsByPackage.entries()).map(([k, v]) => `${k}@${v}`).join(', ')}`))
      }
      const healthCheckCfg = effectiveSellerConfig.healthCheck
      const healthCheckEnabled = healthCheckCfg?.enabled !== false
      const gasCheckCfg = effectiveSellerConfig.gasCheck
      const gasCheckEnabled = paymentsEnabled && Boolean(config.payments.crypto) && gasCheckCfg?.enabled !== false
      const gasCheckIntervalMs = gasCheckCfg?.intervalMs ?? DEFAULT_GAS_CHECK_INTERVAL_MS
      const minGasBalanceWei = gasCheckCfg?.minBalanceEth !== undefined
        ? ethToWei(gasCheckCfg.minBalanceEth)
        : DEFAULT_MIN_GAS_BALANCE_WEI
      const gasRefuelSettings = resolveGasRefuelSettings(effectiveSellerConfig.gasRefuel)

      console.log(chalk.bold('Effective seller settings:'))
      if (overriddenSettings.length > 0) {
        console.log(chalk.dim(`  saved from the dashboard (over ${resolveConfigPath(globalOpts.config)}): ${overriddenSettings.join(', ')}`))
      }
      console.log(chalk.dim(`  providers: ${selectedProviderNames.join(', ')}`))
      for (let index = 0; index < providers.length; index += 1) {
        const provider = providers[index]!
        const providerName = selectedProviderNames[index]!
        console.log(
          chalk.dim(
            `  ${providerName} pricing defaults (USD/1M): input=${provider.pricing.defaults.inputUsdPerMillion}, output=${provider.pricing.defaults.outputUsdPerMillion}`
          )
        )
      }
      const minBudgetPerRequest = config.payments.minBudgetPerRequest ?? '10000'
      console.log(chalk.dim(`  min budget per request: ${minBudgetPerRequest} base units`))
      if (paymentConfig?.crypto?.rpcUrl) {
        const rpcSource = baseRpcUrlOverride ? 'runtime override' : 'config/default'
        console.log(chalk.dim(`  Base RPC URL: ${paymentConfig.crypto.rpcUrl} (${rpcSource})`))
        if (isPublicRpcUrl(paymentConfig.crypto.rpcUrl)) {
          console.log(chalk.yellow('  Warning: using a public Base RPC. Public RPCs can be rate-limited or lag on event/log polling; sellers should use a dedicated RPC for reliable payment channel settlement. Learn how to configure one: https://antseed.com/docs/buyer-config#base-rpc-url'))
        }
      }
      // CLI flag (decimal USDC) overrides config JSON (base-unit string).
      const minSettleDeltaFlag = options.minSettleDelta as string | undefined
      const minSettleDelta = minSettleDeltaFlag !== undefined
        ? toUSDCBaseUnits(minSettleDeltaFlag, DEFAULT_MIN_SETTLE_DELTA_STR)
        : (config.payments.minSettleDelta ?? DEFAULT_MIN_SETTLE_DELTA_STR)
      console.log(chalk.dim(`  min settle delta: ${minSettleDelta} base units`))
      if (config.payments.serveWhileClosePending) {
        console.log(chalk.yellow('  Warning: serveWhileClosePending is enabled. Channels whose buyer already requested close on-chain will still be served, and their withdraw timer may already have matured — work served on them can become uncollectible.'))
      }
      console.log(chalk.dim(`  reserve floor: ${effectiveSellerConfig.reserveFloor}`))
      console.log(chalk.dim(`  max concurrent buyers: ${effectiveSellerConfig.maxConcurrentBuyers}`))
      if (sellerFreeTier) {
        const freeTierPreview = new SellerFreeTierLimiter(sellerFreeTier)
        freeTierPreview.setPaidServices(pricedSellerServices(effectiveSellerConfig, selectedProviderNames))
        console.log(chalk.dim('  free tier:'))
        for (const line of freeTierPreview.describePrograms()) console.log(chalk.dim(`    ${line}`))
        if (!sellerFreeTier.maxRequestsPerAddress && !sellerFreeTier.maxRequestsPerIp) {
          console.log(chalk.dim('    other free models: unlimited'))
        }
      } else {
        console.log(chalk.dim('  free tier: unlimited for fully zero-priced services'))
      }
      if (healthCheckEnabled) {
        const intervalMs = healthCheckCfg?.intervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS
        const failureThreshold = healthCheckCfg?.failureThreshold ?? DEFAULT_HEALTH_CHECK_FAILURE_THRESHOLD
        console.log(chalk.dim(`  model health checks: every ${Math.round(intervalMs / 1000)}s for models without buyer traffic, announce failing after ${failureThreshold} consecutive failures`))
      } else {
        console.log(chalk.dim('  model health checks: disabled'))
      }
      if (gasCheckEnabled) {
        console.log(chalk.dim(`  gas checks: every ${Math.round(gasCheckIntervalMs / 1000)}s, pause advertising below ${formatEther(minGasBalanceWei)} ETH`))
        console.log(chalk.dim(gasRefuelSettings.enabled
          ? `  gas auto-refuel: below ${formatEther(gasRefuelSettings.triggerBalanceWei)} ETH swap ${Number(gasRefuelSettings.swapUsdcUnits) / 1e6} USDC for ETH (max ${Number(gasRefuelSettings.maxUsdcPerDayUnits) / 1e6} USDC/day)`
          : '  gas auto-refuel: off'))
      }
      const restrictedCountries = new Set(effectiveSellerConfig.restrictedCountries ?? DEFAULT_RESTRICTED_COUNTRIES)
      let acceptInboundAddress: ((remoteAddress: string) => boolean) | undefined
      if (restrictedCountries.size > 0) {
        try {
          const geoip = createRequire(import.meta.url)('geoip-country') as typeof import('geoip-country')
          acceptInboundAddress = (ip) => !restrictedCountries.has(geoip.lookup(ip)?.country ?? '')
          console.log(chalk.dim(`  restricted countries: ${[...restrictedCountries].join(', ')}`))
        } catch (err) {
          console.log(chalk.yellow(`  restricted countries: off, geoip-country failed to load (${(err as Error).message})`))
        }
      }
      const maxUploadBodyBytes = parseOptionalPositiveIntegerEnv(process.env['ANTSEED_MAX_UPLOAD_BODY_BYTES'])
        ?? effectiveSellerConfig.maxUploadBodyBytes
      if (maxUploadBodyBytes !== undefined) {
        console.log(chalk.dim(`  max upload body bytes: ${maxUploadBodyBytes}`))
      }
      const verificationDomains = (effectiveSellerConfig.verifications?.domains ?? []).map((claim) => claim.domain)
      if (verificationDomains.length > 0) {
        console.log(chalk.dim(`  domain verification: ${verificationDomains.join(', ')}`))
      }
      const verificationGithub = (effectiveSellerConfig.verifications?.github ?? []).map((claim) => claim.username)
      if (verificationGithub.length > 0) {
        console.log(chalk.dim(`  github verification: ${verificationGithub.join(', ')}`))
      }
      console.log('')

      const nodeSpinner = ora('Starting seeding daemon...').start()

      const dhtPort = options.dhtPort as number | undefined
      const signalingPort = options.signalingPort as number | undefined

      const sellerContractCfg = config.payments?.sellerContract
      const announcerSellerContract = sellerContractCfg
        ? { sellerContract: sellerContractCfg.address }
        : undefined

      // Load provers before advertising verifier capabilities.
      let requestedVerifierIds: string[]
      try {
        requestedVerifierIds = normalizeVerifierIds(
          (options.verifiers as string | undefined)
            ?? process.env[ANTSEED_VERIFIER_SDKS_ENV]
            ?? config.seller.verifiers?.join(',')
            ?? '',
        )
      } catch (err) {
        console.error(chalk.red((err as Error).message))
        process.exit(1)
      }
      const loadedProvers: Prover[] = []
      for (const id of requestedVerifierIds) {
        try {
          const prover = await loadProverPlugin(id)
          if (prover.name !== id) {
            throw new Error(`its package exported a prover named "${prover.name}" — advertised id and prover name must match`)
          }
          loadedProvers.push(prover)
        } catch (err) {
          console.error(chalk.red(`Cannot advertise verifier "${id}": ${(err as Error).message.split('\n')[0]}`))
          process.exit(1)
        }
      }
      const verifierCapabilities = buildVerifierCapabilities(requestedVerifierIds)

      const announcedCapabilities = [
        ...verifierCapabilities,
        ...(healthCheckEnabled ? [CONNECTION_CAPABILITY_MODEL_HEALTH_V1] : []),
      ]

      const node = new AntseedNode({
        role: 'seller',
        displayName: config.identity.displayName,
        ...(config.seller.publicAddress ? { publicAddress: config.seller.publicAddress } : {}),
        ...(effectiveSellerConfig.verifications ? { verifications: effectiveSellerConfig.verifications } : {}),
        ...(announcedCapabilities.length > 0 ? { capabilities: announcedCapabilities } : {}),
        bootstrapNodes,
        dataDir: globalOpts.dataDir,
        ...(dhtPort ? { dhtPort } : {}),
        ...(signalingPort ? { signalingPort } : {}),
        ...(maxUploadBodyBytes !== undefined ? { maxUploadBodyBytes } : {}),
        ...(sellerFreeTier ? { freeTier: sellerFreeTier } : {}),
        ...(effectiveSellerConfig.freeUsage ? { freeUsage: effectiveSellerConfig.freeUsage } : {}),
        ...(acceptInboundAddress ? { acceptInboundAddress } : {}),
        payments: {
          enabled: paymentsEnabled,
          paymentMethod: preferredMethod,
          settlementIdleMs: Number.isFinite(settlementIdleMs) ? settlementIdleMs : 30_000,
          defaultDepositAmountUSDC: defaultDepositAmountUSDCBaseUnits,
          sellerWalletAddress,
          paymentConfig,
          minBudgetPerRequest: config.payments.minBudgetPerRequest ?? '10000',
          minSettleDelta,
          ...(config.payments.serveWhileClosePending !== undefined
            ? { serveWhileClosePending: config.payments.serveWhileClosePending }
            : {}),
          // Top-level fields required by the node for contract clients + EIP-712 domain
          ...(paymentConfig?.crypto ? {
            rpcUrl: paymentConfig.crypto.rpcUrl,
            ...(paymentConfig.crypto.fallbackRpcUrls ? { fallbackRpcUrls: paymentConfig.crypto.fallbackRpcUrls } : {}),
            depositsAddress: paymentConfig.crypto.depositsContractAddress,
            channelsAddress: paymentConfig.crypto.channelsContractAddress,
            ...(paymentConfig.crypto.freeUsageContractAddress ? { freeUsageAddress: paymentConfig.crypto.freeUsageContractAddress } : {}),
            usdcAddress: paymentConfig.crypto.usdcAddress,
            identityRegistryAddress: resolveChainConfig({ chainId: paymentConfig.crypto.chainId }).identityRegistryAddress,
            stakingAddress: resolveChainConfig({ chainId: paymentConfig.crypto.chainId }).stakingContractAddress,
            chainId: resolveChainConfig({ chainId: paymentConfig.crypto.chainId }).evmChainId,
            ...(sellerPoolsAddress ? { sellerPoolsAddress } : {}),
            ...(depositRelayAddress ? { depositRelayAddress } : {}),
          } : {}),
        },
        ...(config.relayer ? { relayer: config.relayer } : {}),
        ...(announcerSellerContract ? { sellerContract: announcerSellerContract } : {}),
      })

      let registeredProviders = providers

      // Wrap provider with ant agent if configured
      if (effectiveSellerConfig.agentDir) {
        const baseDir = globalOpts.config ? dirname(resolve(globalOpts.config)) : process.cwd()
        const resolvePath = (p: string) => isAbsolute(p) ? p : resolve(baseDir, p)

        try {
          if (typeof effectiveSellerConfig.agentDir === 'string') {
            // Single agent for all services
            const agentDef = await loadAntAgent(resolvePath(effectiveSellerConfig.agentDir))
            registeredProviders = registeredProviders.map((provider) => new AntAgentProvider(provider, agentDef))
            const k = agentDef.knowledge.length
            console.log(chalk.dim(`  ant agent: "${agentDef.name}" (${k} knowledge module${k !== 1 ? 's' : ''})`))
          } else {
            // Per-service agents
            const agentMap: Record<string, AntAgentDefinition> = {}
            for (const [service, dir] of Object.entries(effectiveSellerConfig.agentDir)) {
              const agentDef = await loadAntAgent(resolvePath(dir))
              agentMap[service] = agentDef
              const k = agentDef.knowledge.length
              const label = service === '*' ? '(default)' : service
              console.log(chalk.dim(`  ant agent: "${agentDef.name}" → ${label} (${k} knowledge module${k !== 1 ? 's' : ''})`))
            }
            registeredProviders = registeredProviders.map((provider) => new AntAgentProvider(provider, agentMap))
          }
        } catch (err) {
          console.error(chalk.red(`Failed to load ant agent: ${(err as Error).message}`))
          process.exit(1)
        }
      }

      for (const [index, provider] of registeredProviders.entries()) {
        // Preserve initial unavailability across optional agent wrappers.
        if (providers[index]?.healthCheckAvailable === false) provider.healthCheckAvailable = false
        node.registerProvider(provider)
      }

      for (const prover of loadedProvers) {
        node.registerProver(prover)
        console.log(chalk.dim(`  Verifier prover embedded: ${prover.name}`))
      }

      try {
        await node.start()
        nodeSpinner.succeed(chalk.green('Seeding active'))
        console.log(chalk.dim(`  Peer ID: ${node.peerId ?? 'unknown'}`))
        console.log(chalk.dim(`  DHT port: ${node.dhtPort}`))
        console.log(chalk.dim(`  Signaling port: ${node.signalingPort}`))
        const reachabilityWarning = startupReachabilityWarning(config.seller.publicAddress)
        if (reachabilityWarning) {
          console.log('')
          console.warn(chalk.yellow.bold(reachabilityWarning))
        }
        if (requestedVerifierIds.length > 0) {
          console.log(chalk.dim(`  Verifiers advertised: ${requestedVerifierIds.join(', ')}`))
        }
      } catch (err) {
        nodeSpinner.fail(chalk.red(`Failed to start seeding: ${(err as Error).message}`))
        process.exit(1)
      }

      // Periodic model health self-checks: buyer traffic counts as a check, and
      // idle text services are probed with a minimal completion. Services that
      // keep failing stay announced with a failing status in signed metadata
      // (buyers skip them) until a check passes again.
      // Image and video services are not probed because a meaningful probe
      // would generate and charge for media. Providers check them with free
      // account and model-list calls instead (checkUpstreamAccount,
      // checkServiceHealth).
      // Seller events: journaled to <dataDir>/seller-events.jsonl for the dashboard,
      // and sent to the channels in seller.alerts (if any).
      const alerts = new SellerAlerts({
        dataDir: globalOpts.dataDir,
        // Re-read on change: alert edits (dashboard, console, by hand) apply without a restart.
        configPath: resolveConfigPath(globalOpts.config),
        sellerName: config.identity.displayName || `seller ${(node.peerId ?? '').slice(0, 8)}`,
        ...(node.peerId ? { peerId: node.peerId } : {}),
        log: (line) => console.log(chalk.yellow(line)),
      })
      const previousState = await readFile(getStateFile(globalOpts.dataDir), 'utf-8').catch(() => null)
      const crashed = uncleanExitEvent(previousState, Date.now())
      if (crashed) void alerts.record(crashed)
      void alerts.record({ kind: 'started', severity: 'info', title: `Seller started (v${pkg.version})` })
      if (alerts.channels().length > 0) console.log(chalk.dim(`  alerts: ${alerts.channels().join(', ')}`))
      else console.log(chalk.dim('  alerts: off (journal only). Send them to Telegram or a webhook with `antseed seller alerts set` or `antseed seller dashboard`; a running seller picks the change up.'))
      // Model and upstream-credit alerts go out per upstream: one message for a round of withdrawals, and the cause when it is billing.
      const upstreamHost = (providerId: string) => {
        const baseUrl = effectiveSellerConfig.providers[providerId]?.baseUrl
        try { return baseUrl ? new URL(baseUrl).host : null } catch { return null }
      }
      const upstreamAlerts = new UpstreamAlerts(alerts, { hostOf: upstreamHost })

      let healthChecker: ModelHealthChecker | null = null
      if (healthCheckEnabled && registeredProviders.length > 0) {
        healthChecker = new ModelHealthChecker({
          targets: registeredProviders.map((provider, index) => ({
            provider,
            // Probe the unwrapped provider so an ant-agent wrapper doesn't
            // run a full agent loop for every probe.
            ...(providers[index] && providers[index] !== provider ? { probeProvider: providers[index]! } : {}),
            ...(selectedProviderNames[index] ? { id: selectedProviderNames[index] } : {}),
          })),
          ...(healthCheckCfg?.intervalMs !== undefined ? { intervalMs: healthCheckCfg.intervalMs } : {}),
          ...(healthCheckCfg?.failureThreshold !== undefined ? { failureThreshold: healthCheckCfg.failureThreshold } : {}),
          onChange: (event) => {
            if (event.status === 'failing') {
              console.log(chalk.yellow(`Model ${event.provider}/${event.service} announced as failing — self health check failed (${event.detail})`))
            } else {
              console.log(chalk.green(`Model ${event.provider}/${event.service} announced as healthy — self health check recovered (${event.detail})`))
            }
            upstreamAlerts.modelChanged(event)
            void node.refreshSellerMetadata().catch(() => {})
          },
          onUpstreamAccount: (event) => {
            console.log((event.status === 'funded' ? chalk.green : chalk.yellow)(`Upstream ${event.providerId}: ${event.status.replace('_', ' ')} (${event.detail})`))
            upstreamAlerts.account(event)
          },
          onSweepComplete: () => {
            upstreamAlerts.flush()
            // Re-sign so announced check times stay current between status changes.
            void node.refreshSellerMetadata().catch(() => {})
          },
          // Read on every check, so a dashboard edit applies without a restart.
          lowBalanceUsd: () => alerts.settings.config.lowBalanceUsd ?? DEFAULT_LOW_BALANCE_USD,
        })
        const checker = healthChecker
        // Live traffic is health evidence: a success spares the next probe, an
        // upstream failure triggers one early, and an out-of-credit error is seen first.
        node.on('provider:response', ({ provider, service, statusCode, body, billable }: { provider: Provider; service: string; statusCode: number; body: string; billable: boolean }) => checker.reportUpstreamResponse(provider, statusCode, body, billable, service))
        node.on('provider:failure', ({ provider, service, billable }: { provider: Provider; service: string; billable: boolean }) => checker.reportUpstreamFailure(provider, service, billable))
        healthChecker.start()
      }

      // Operator-facing notices surfaced via daemon.state.json (seller status
      // command and desktop). Currently only the out-of-gas notice.
      let gasNotice: string | null = null
      let gasMonitor: GasHealthMonitor | null = null
      let gasRefueler: GasAutoRefueler | null = null

      // Write daemon state so dashboard and connect can discover this seeder
      const startedAt = Date.now()
      const syntheticSessionStarts = new Map<string, number>()
      let stateWriteInFlight = false
      let stateWritePending = false

      function formatUptime(): string {
        const ms = Date.now() - startedAt
        const s = Math.floor(ms / 1000)
        if (s < 60) return `${s}s`
        const m = Math.floor(s / 60)
        if (m < 60) return `${m}m ${s % 60}s`
        const h = Math.floor(m / 60)
        return `${h}h ${m % 60}m`
      }

      function buildDaemonState() {
        const now = Date.now()
        const primaryProvider = registeredProviders[0]!
        const capacity = registeredProviders.map((provider) => provider.getCapacity())
        const cap = capacity.reduce(
          (acc, entry) => ({ current: acc.current + entry.current, max: acc.max + entry.max }),
          { current: 0, max: 0 },
        )
        const trackedSessions = node
          .getActiveSellerSessions()
          .filter((session) => !session.settling)
          .map((session) => ({
            sessionId: session.sessionId,
            buyerPeerId: session.buyerPeerId,
            provider: session.provider,
            startedAt: session.startedAt,
            lastActivityAt: session.lastActivityAt,
            totalRequests: session.totalRequests,
            totalTokens: session.totalTokens,
            avgLatencyMs: session.avgLatencyMs,
          }))

        const syntheticCount = Math.max(0, cap.current - trackedSessions.length)
        const syntheticIds = new Set<string>()
        const syntheticDetails: Array<{
          sessionId: string
          buyerPeerId: string
          provider: string
          startedAt: number
          lastActivityAt: number
          totalRequests: number
          totalTokens: number
          avgLatencyMs: number
        }> = []

        for (let i = 0; i < syntheticCount; i += 1) {
          const sessionId = `provider-slot-${i + 1}`
          syntheticIds.add(sessionId)

          const existingStart = syntheticSessionStarts.get(sessionId)
          const startedAtTs = typeof existingStart === 'number' ? existingStart : now
          syntheticSessionStarts.set(sessionId, startedAtTs)

          syntheticDetails.push({
            sessionId,
            buyerPeerId: 'unknown',
            provider: primaryProviderName,
            startedAt: startedAtTs,
            lastActivityAt: now,
            totalRequests: 0,
            totalTokens: 0,
            avgLatencyMs: 0,
          })
        }

        for (const existingId of syntheticSessionStarts.keys()) {
          if (!syntheticIds.has(existingId)) {
            syntheticSessionStarts.delete(existingId)
          }
        }

        const activeChannelDetails = [...trackedSessions, ...syntheticDetails]
        const activeChannelsCount = Math.max(node.getActiveSellerChannelCount(), cap.current)

        return {
          state: 'seeding',
          pid: process.pid,
          peerId: node.peerId,
          dhtPort: node.dhtPort,
          signalingPort: node.signalingPort,
          provider: primaryProviderName,
          defaultInputUsdPerMillion: primaryProvider.pricing.defaults.inputUsdPerMillion,
          defaultOutputUsdPerMillion: primaryProvider.pricing.defaults.outputUsdPerMillion,
          // The providers this seller starts with (`--provider`, or all configured), models turned off or not.
          selectedProviders: providerSelection.selected,
          providerPricing: Object.fromEntries(registeredProviders.map((provider, index) => {
            const providerName = selectedProviderNames[index]!
            return [providerName, {
              defaults: {
                inputUsdPerMillion: provider.pricing.defaults.inputUsdPerMillion,
                outputUsdPerMillion: provider.pricing.defaults.outputUsdPerMillion,
              },
              ...(provider.pricing.services ? { services: provider.pricing.services } : {}),
            }]
          })),
          ...(primaryProvider.serviceCategories
            ? {
                providerServiceCategories: {
                  [primaryProviderName]: {
                    services: primaryProvider.serviceCategories,
                  },
                },
              }
            : {}),
          startedAt,
          // Fields the dashboard reads
          peerCount: 0,
          activeChannels: activeChannelsCount,
          activeChannelDetails,
          capacityUsedPercent: cap.max > 0 ? Math.round((cap.current / cap.max) * 100) : 0,
          earningsToday: '0',
          tokensToday: 0,
          uptime: formatUptime(),
          notices: gasNotice ? [gasNotice] : [],
          // Read by `antseed metrics serve --role seller` for model and gas alerts.
          modelHealth: healthChecker?.getSnapshot() ?? [],
          gas: gasHealthState(gasMonitor, gasRefueler),
          alerts: alerts.state(),
          // Chain RPC calls this process made, per source (the dashboard and metrics exporter show them).
          rpc: rpcUsage(),
          updatedAt: now,
          proxyPort: null,
        }
      }

      // Set on shutdown: the state file is removed then, and no late write may bring it back (a "crash" on the next start).
      let stateStopped = false
      let stateWriteCurrent: Promise<void> | null = null
      async function writeDaemonState(): Promise<void> {
        if (stateStopped) return
        if (stateWriteInFlight) {
          stateWritePending = true
          return
        }

        stateWriteInFlight = true
        try {
          // Replaced whole (temp file, then rename): a reader never sees a half-written state.
          const stateFile = getStateFile(globalOpts.dataDir)
          const temp = `${stateFile}.${process.pid}.tmp`
          stateWriteCurrent = writeFile(temp, JSON.stringify(buildDaemonState(), null, 2)).then(() => rename(temp, stateFile))
          await stateWriteCurrent
        } finally {
          stateWriteInFlight = false
          if (stateWritePending && !stateStopped) {
            stateWritePending = false
            await writeDaemonState()
          }
        }
      }

      function scheduleDaemonStateWrite(): void {
        void writeDaemonState().catch(() => {})
      }

      await writeDaemonState()
      node.on('connection', scheduleDaemonStateWrite)
      node.on('session:updated', scheduleDaemonStateWrite)
      node.on('session:finalized', scheduleDaemonStateWrite)

      const idleWatch = startIdleWatch({
        idleMinutes: () => alerts.idleMinutes(),
        node,
        record: (event) => alerts.record(event),
      })

      // Refresh state file every 1s so the desktop dashboard reflects live counters.
      const stateInterval = setInterval(async () => {
        await writeDaemonState().catch(() => {})
      }, 1_000)

      // Periodic seller-wallet gas checks: a seller whose wallet cannot fund
      // reserve/settle/close transactions rejects every buyer that connects,
      // so pause advertising (and say so) until the wallet is funded again.
      if (gasCheckEnabled && node.identity) {
        const gasWalletAddress = node.identity.wallet.address
        try {
          // Balance reads go through the process's shared provider (coalescing, back-off), tagged for the RPC counters.
          const gasCrypto = requireCryptoConfig(config, { rpcUrl: baseRpcUrlOverride })
          const gasProvider = sharedChainProvider({ rpcUrl: gasCrypto.rpcUrl, evmChainId: gasCrypto.evmChainId, ...(gasCrypto.fallbackRpcUrls ? { fallbackRpcUrls: gasCrypto.fallbackRpcUrls } : {}) })
          // Auto-refuel: swap some of the wallet's USDC earnings for ETH before it runs dry (Base mainnet only).
          const usdcAddress = gasCrypto.usdcContractAddress
          const swapDeployment = usdcEthSwapDeployment(resolveChainConfig({ chainId: gasCrypto.chainId }), { evmChainId: gasCrypto.evmChainId, usdcAddress })
          if (gasRefuelSettings.enabled && !swapDeployment) {
            console.log(chalk.dim('  gas auto-refuel: unavailable on this chain (Base mainnet only)'))
          } else if (gasRefuelSettings.enabled && swapDeployment) {
            const swapClient = new UsdcEthSwapClient({ rpcUrl: gasCrypto.rpcUrl, evmChainId: gasCrypto.evmChainId, usdcAddress, deployment: swapDeployment }).withProvider(gasProvider)
            const wallet = node.identity.wallet
            const dataDir = globalOpts.dataDir
            gasRefueler = new GasAutoRefueler({
              address: gasWalletAddress,
              triggerBalanceWei: gasRefuelSettings.triggerBalanceWei,
              swapUsdcUnits: gasRefuelSettings.swapUsdcUnits,
              maxUsdcPerDayUnits: gasRefuelSettings.maxUsdcPerDayUnits,
              slippageBps: gasRefuelSettings.slippageBps,
              history: await loadGasRefuelHistory(dataDir),
              saveHistory: (records) => saveGasRefuelHistory(dataDir, records),
              swapper: {
                quote: (amount) => withRpcSource('gas', () => swapClient.quote(amount)),
                usdcBalance: (address) => withRpcSource('gas', () => swapClient.usdcBalance(address)),
                maxSwapCostWei: () => withRpcSource('gas', () => swapClient.maxSwapCostWei()),
                swap: (amount, minEthOut) => withRpcSource('gas', () => swapClient.swapUsdcForEth(wallet, amount, minEthOut)),
              },
              onEvent: (event) => {
                if (event.status === 'refueled') {
                  const usdc = Number(event.record.usdcUnits) / 1e6
                  console.log(chalk.green(`Gas auto-refuel: swapped ${usdc} USDC for ~${formatEther(event.expectedEthWei)} ETH (tx ${event.record.txHash}).`))
                  void alerts.record({ kind: 'gas_refueled', severity: 'info', title: `Gas refueled: swapped ${usdc} USDC for ETH`, detail: `tx ${event.record.txHash}` })
                  void gasMonitor?.checkNow()
                } else if (event.status === 'failed') {
                  console.log(chalk.yellow(`Gas auto-refuel failed: ${event.error}. Retrying at ${new Date(event.retryAt).toISOString()}.`))
                  void alerts.record({ kind: 'gas_refuel_failed', severity: 'warning', title: 'Gas auto-refuel failed', detail: `${event.error}. Send ETH to ${event.address} if this persists.` })
                } else {
                  console.log(chalk.yellow(`Gas auto-refuel skipped (${event.reason}): ${event.detail}.`))
                  void alerts.record({ kind: 'gas_refuel_failed', severity: 'warning', title: 'Gas auto-refuel skipped', detail: `${event.detail}. Send ETH to ${event.address} to keep selling.` })
                }
                scheduleDaemonStateWrite()
              },
            })
          }
          gasMonitor = new GasHealthMonitor({
            address: gasWalletAddress,
            getBalance: (address) => withRpcSource('gas', () => gasProvider.getBalance(address)),
            intervalMs: gasCheckIntervalMs,
            minBalanceWei: minGasBalanceWei,
            ...(gasRefueler ? { onBalance: (balanceWei: bigint) => gasRefueler?.onBalance(balanceWei) } : {}),
            onChange: (event) => {
              const balanceSummary = `wallet ${event.address} holds ${formatEther(event.balanceWei)} ETH (minimum ${formatEther(event.minBalanceWei)} ETH)`
              if (event.status === 'depleted') {
                gasNotice = `Out of gas: ${balanceSummary}. Advertising is paused; send ETH to ${event.address} to resume.`
                console.log(chalk.yellow.bold('\nSeller out of gas — advertising paused.'))
                console.log(chalk.yellow(`  On-chain settlement would fail and buyers would be rejected: ${balanceSummary}.`))
                console.log(chalk.cyan(`  Send ETH to ${event.address} — advertising resumes automatically once funded.`))
                void node.pauseAdvertising('out-of-gas').catch(() => {})
                void alerts.record({ kind: 'gas_low', severity: 'critical', title: 'Out of gas: advertising paused', detail: `${balanceSummary}. Send ETH to ${event.address} to resume.` })
              } else {
                gasNotice = null
                void alerts.record({ kind: 'gas_ok', severity: 'info', title: `Gas restored (${formatEther(event.balanceWei)} ETH): advertising resumed` })
                console.log(chalk.green(`Gas balance restored (${formatEther(event.balanceWei)} ETH) — advertising resumed.`))
                node.resumeAdvertising()
              }
              scheduleDaemonStateWrite()
            },
          })
          gasMonitor.start()
        } catch (err) {
          console.log(chalk.dim(`  gas checks unavailable: ${(err as Error).message}`))
        }
      }

      // The local dashboard, unless turned off. Its link carries a session token, so it is printed only to a
      // terminal; a service's logs say how to get it (`antseed seller dashboard` reads it from the data dir).
      let dashboard: SellerDashboardServer | null = null
      if (options.dashboard !== false) {
        // A restart from the dashboard is a clean stop: only offered where a supervisor starts the seller again.
        const supervisor = restartSupervisor()
        const restart = {
          unavailableReason: supervisor ? null : 'Restart `antseed seller start` where it runs to apply saved changes. (Under a supervisor that starts it again when it exits, set ANTSEED_SUPERVISED=1 to restart it from here.)',
          run: () => {
            console.log(chalk.yellow(`Restarting from the dashboard to apply saved settings (${supervisor} starts the seller again).`))
            shutdownForRestart()
          },
        }
        // A restart keeps the link (and the sessions signed with it), so an open dashboard reconnects.
        const previousToken = previousDashboardToken(globalOpts.dataDir)
        const dashboardOptions = { dataDir: globalOpts.dataDir, configPath: resolveConfigPath(globalOpts.config), version: pkg.version, host: '127.0.0.1', restart, ...(previousToken ? { token: previousToken } : {}), log: (line: string) => console.log(chalk.dim(line)) }
        // The flag's port; else the one the last run served on (an open page reconnects there after a restart),
        // then the default, then any free one.
        const previousPort = previousDashboardPort(globalOpts.dataDir)
        const ports = options.dashboardPort ? [Number(options.dashboardPort)] : [...new Set([previousPort, DEFAULT_SELLER_DASHBOARD_PORT, 0].filter((port): port is number => port !== null))]
        try {
          for (const [index, port] of ports.entries()) {
            try {
              dashboard = await startSellerDashboard({ ...dashboardOptions, port })
              break
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || index === ports.length - 1) throw err
            }
          }
          if (!dashboard) throw new Error('no port to serve on')
          await writeDashboardLink(globalOpts.dataDir, dashboard.url)
          const origin = new URL(dashboard.url).origin
          if (process.stdout.isTTY) console.log(`  dashboard: ${chalk.cyan(dashboard.url)}`)
          else console.log(`  dashboard: ${origin} (\`antseed seller dashboard\` on this host prints its link; --no-dashboard turns it off)`)
        } catch (err) {
          console.log(chalk.yellow(`  dashboard unavailable: ${(err as Error).message}`))
        }
      }

      const updateWatch = watchForUpdates({
        dataDir: globalOpts.dataDir,
        current: pkg.version,
        running: 'seller',
        log: (line) => console.log(chalk.yellow(line)),
      })

      setupShutdownHandler(async () => {
        updateWatch.stop()
        idleWatch.stop()
        healthChecker?.stop()
        gasMonitor?.stop()
        // A refuel swap already sent keeps going while channels finalize; it is saved to the daily-cap history when mined.
        const refuelStopped = gasRefueler?.stop() ?? Promise.resolve()
        clearInterval(stateInterval)
        node.off('connection', scheduleDaemonStateWrite)
        node.off('session:updated', scheduleDaemonStateWrite)
        node.off('session:finalized', scheduleDaemonStateWrite)
        upstreamAlerts.close()
        alerts.close()
        if (dashboard) {
          // Never long: channels are finalized next, and a dashboard request must not hold that up.
          await waitAtMost((isRestarting() ? Promise.resolve() : removeDashboardLink(globalOpts.dataDir)).then(() => dashboard!.close()), 2_000)
        }
        nodeSpinner.start('Shutting down seeding daemon...')
        try {
          await node.stop()
          nodeSpinner.succeed('Seeding daemon stopped. Channels finalized.')
        } catch (err) {
          nodeSpinner.fail(`Seeding daemon stopped with an error: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
          // A clean stop, even one whose node shutdown failed: no state file, so the next start reports no crash.
          stateStopped = true
          await stateWriteCurrent?.catch(() => {})
          await unlink(getStateFile(globalOpts.dataDir)).catch(() => {})
          await waitAtMost(refuelStopped, GAS_REFUEL_SHUTDOWN_WAIT_MS)
          // Only once the node is down, and never for long: alert delivery is remote and best effort.
          await waitAtMost(alerts.record({ kind: 'stopped', severity: 'info', title: 'Seller stopped' }))
        }
      })
    })
}

/**
 * Who starts the seller again after a restart from the dashboard, or null when
 * nothing would (the restart would stop it for good). Never inferred from
 * variables a shell inherits: `ANTSEED_SUPERVISED=1` says so explicitly (`0`
 * turns it off), and otherwise only a Kubernetes container's main process
 * counts, which the kubelet restarts.
 */
export function restartSupervisor(env: NodeJS.ProcessEnv = process.env, pid = process.pid): string | null {
  if (env.ANTSEED_SUPERVISED === '0') return null
  if (env.ANTSEED_SUPERVISED === '1') return 'its supervisor'
  return env.KUBERNETES_SERVICE_HOST && pid === 1 ? 'Kubernetes' : null
}
