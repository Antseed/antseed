import { detectInstallMethod, type InstallMethod } from '../update/install-method.js'
import {
  readRootUpdateProgress,
  readUpdaterAppVersions,
  ROOT_UPDATE_STALE_MS,
  requestRootUpdate,
  rootUpdaterPaths,
  updateInFlight,
  type RootUpdateAction,
  type RootUpdateProgress,
  type RootUpdaterPaths,
} from '../update/root-updater.js'
import { updateAvailableLine } from '../update/notifier.js'
import { fetchLatestVersion, isNewer, readUpdateCache, UPDATE_CHECK_INTERVAL_MS, updateChecksDisabled, writeUpdateCache } from '../update/version.js'
import type { GatewayUpdate } from './console-api/types.js'

/** The gateway re-asks npm this often on its own, like the desktop app; the console's Check now button forces it. */
const GATEWAY_CHECK_INTERVAL_MS = UPDATE_CHECK_INTERVAL_MS
/** Forced checks closer together than this reuse the last answer. */
const FORCED_CHECK_MIN_GAP_MS = 15_000

export interface GatewayUpdates {
  /** What the console shows; starts a background registry check when the last one is stale. */
  info(): GatewayUpdate
  /** Asks the registry now. */
  check(): Promise<GatewayUpdate>
  /**
   * Asks the root updater (or the desktop app) to download the latest
   * version, or to install it and restart. Callers check
   * `info().apply === 'console'` first.
   */
  apply(requestedBy: string, action?: RootUpdateAction): GatewayUpdate
  /**
   * Checks every 30 minutes while the gateway runs and logs the first time
   * it sees each newer version. Nothing installs until someone asks.
   */
  watch(): void
  stop(): void
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
  const updater: RootUpdaterPaths | null = method.kind === 'installer' || method.kind === 'desktop' ? rootUpdaterPaths(env) : null
  // The desktop app checks its own releases; npm's CLI version is not what it ships.
  const desktop = method.kind === 'desktop' && updater !== null
  const disabled = updateChecksDisabled(env)
  // The desktop app finishes an install on its next launch, however long that takes.
  const progress = () => updater ? readRootUpdateProgress(updater, desktop ? {} : { staleAfterMs: ROOT_UPDATE_STALE_MS, now: now() }) : null

  let latest: string | null = null
  let checkedAt: number | null = null
  let checkError: string | null = null
  let inFlight: Promise<void> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let announced: string | null = null

  // Logs each newer version once, the way a running seller does.
  function announce(): void {
    if (!latest || !isNewer(latest, options.current) || latest === announced) return
    announced = latest
    options.log?.(updateAvailableLine(latest, options.current, method, 'gateway'))
  }

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
        announce()
        try {
          writeUpdateCache(options.dataDir, { checkedAt, latest })
        } catch {
          // memory is enough for the console
        }
      } catch (error) {
        checkError = error instanceof Error ? error.message : String(error)
        checkedAt = now()
        options.log?.(`update check failed: ${checkError}`)
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  // Ready to install whatever npm's latest has moved on to; not once it runs.
  function downloaded(run: RootUpdateProgress | null, current: string): string | null {
    return run?.state === 'ready' && isNewer(run.to, current) ? run.to : null
  }

  function info(): GatewayUpdate {
    const run = progress()
    if (desktop) {
      const app = readUpdaterAppVersions(updater)
      const current = app?.current ?? options.current
      const latest = app?.latest ?? null
      return {
        product: 'desktop',
        current,
        latest,
        available: isNewer(latest, current),
        checkedAt: app?.checkedAt ?? null,
        checkError: app?.error ?? null,
        checksDisabled: false,
        apply: 'console',
        install: method.kind,
        command: null,
        note: method.note,
        progress: run,
        downloaded: downloaded(run, current),
      }
    }
    return {
      product: 'cli',
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
      progress: run,
      downloaded: downloaded(run, options.current),
    }
  }

  return {
    info() {
      if (!desktop && !disabled && (checkedAt === null || now() - checkedAt > GATEWAY_CHECK_INTERVAL_MS)) void runCheck()
      return info()
    },
    async check() {
      if (desktop) return info()
      if (checkedAt === null || now() - checkedAt > FORCED_CHECK_MIN_GAP_MS || inFlight) await runCheck()
      return info()
    },
    apply(requestedBy, action = 'install') {
      if (!updater) throw new Error('This gateway has no update service')
      if (!updateInFlight(progress())) requestRootUpdate(updater, requestedBy, now(), action)
      return info()
    },
    watch() {
      if (timer || desktop || disabled) return
      if (checkedAt === null || now() - checkedAt > GATEWAY_CHECK_INTERVAL_MS) void runCheck()
      else announce()
      timer = setInterval(() => { void runCheck() }, GATEWAY_CHECK_INTERVAL_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
