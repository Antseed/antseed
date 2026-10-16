import { detectInstallMethod, type InstallMethod } from '../update/install-method.js'
import {
  readRootUpdateProgress,
  requestRootUpdate,
  rootUpdaterPaths,
  updateInFlight,
  type RootUpdaterPaths,
} from '../update/root-updater.js'
import { fetchLatestVersion, isNewer, readUpdateCache, updateChecksDisabled, writeUpdateCache } from '../update/version.js'
import type { GatewayUpdate } from './console-api/types.js'

/** The gateway re-asks npm at most this often on its own; the console's Check now button forces it. */
const GATEWAY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Forced checks closer together than this reuse the last answer. */
const FORCED_CHECK_MIN_GAP_MS = 15_000

export interface GatewayUpdates {
  /** What the console shows; starts a background registry check when the last one is stale. */
  info(): GatewayUpdate
  /** Asks the registry now. */
  check(): Promise<GatewayUpdate>
  /** Asks the root updater to install the latest CLI. Callers check `info().apply === 'console'` first. */
  apply(requestedBy: string): GatewayUpdate
}

export interface GatewayUpdatesOptions {
  dataDir: string
  current: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  fetchLatest?: () => Promise<string>
  method?: InstallMethod
  log?: (message: string) => void
}

export function createGatewayUpdates(options: GatewayUpdatesOptions): GatewayUpdates {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const fetchLatest = options.fetchLatest ?? (() => fetchLatestVersion())
  const method = options.method ?? detectInstallMethod({ env })
  const updater: RootUpdaterPaths | null = method.kind === 'installer' ? rootUpdaterPaths(env) : null
  const disabled = updateChecksDisabled(env)

  let latest: string | null = null
  let checkedAt: number | null = null
  let checkError: string | null = null
  let inFlight: Promise<void> | null = null

  const cached = readUpdateCache(options.dataDir)
  if (cached) {
    latest = cached.latest
    checkedAt = cached.checkedAt
  }

  function runCheck(): Promise<void> {
    inFlight ??= (async () => {
      try {
        latest = await fetchLatest()
        checkedAt = now()
        checkError = null
        try {
          writeUpdateCache(options.dataDir, { checkedAt, latest })
        } catch {
          // memory is enough for the console
        }
      } catch (error) {
        checkError = error instanceof Error ? error.message : String(error)
        checkedAt = now()
        options.log?.(`gateway: update check failed: ${checkError}`)
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  function info(): GatewayUpdate {
    return {
      current: options.current,
      latest,
      available: isNewer(latest, options.current),
      checkedAt,
      checkError,
      checksDisabled: disabled,
      apply: updater ? 'console' : method.command ? 'command' : 'none',
      install: method.kind,
      command: method.command,
      note: method.note,
      progress: updater ? readRootUpdateProgress(updater) : null,
    }
  }

  return {
    info() {
      if (!disabled && (checkedAt === null || now() - checkedAt > GATEWAY_CHECK_INTERVAL_MS)) void runCheck()
      return info()
    },
    async check() {
      if (checkedAt === null || now() - checkedAt > FORCED_CHECK_MIN_GAP_MS || inFlight) await runCheck()
      return info()
    },
    apply(requestedBy) {
      if (!updater) throw new Error('This gateway has no update service')
      if (!updateInFlight(readRootUpdateProgress(updater))) requestRootUpdate(updater, requestedBy, now())
      return info()
    },
  }
}
