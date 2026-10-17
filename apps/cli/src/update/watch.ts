import { detectInstallMethod, type InstallMethod } from './install-method.js'
import { NOTIFY_KINDS, updateAvailableLine } from './notifier.js'
import {
  fetchLatestVersion,
  isNewer,
  readUpdateCache,
  registryUrl,
  UPDATE_CHECK_INTERVAL_MS,
  updateChecksDisabled,
  writeUpdateCache,
} from './version.js'

export interface UpdateWatchOptions {
  dataDir: string
  current: string
  /** What runs, for the notice: `seller`, `buyer`. */
  running: string
  log: (line: string) => void
  env?: NodeJS.ProcessEnv
  method?: InstallMethod
  fetchLatest?: () => Promise<string>
  now?: () => number
  intervalMs?: number
}

export interface UpdateWatch {
  /** Asks the registry now (or reads a fresh cache) and announces a version not announced yet. */
  check(): Promise<void>
  stop(): void
}

/**
 * Checks npm every 30 minutes while a seller or buyer runs, and logs one line
 * the first time it sees each newer version. It never installs anything:
 * like the desktop app's "Update available", the person runs
 * `antseed update` and restarts when it suits them. Off where the notice is
 * (`NO_UPDATE_NOTIFIER`, `ANTSEED_NO_UPDATE_CHECK`, CI) and for installs
 * that update some other way (the desktop app, npx, project dependencies).
 */
export function watchForUpdates(options: UpdateWatchOptions): UpdateWatch {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const method = options.method ?? detectInstallMethod({ env })
  const fetchLatest = options.fetchLatest ?? (() => fetchLatestVersion({ registry: registryUrl(env) }))
  const intervalMs = options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
  let announced: string | null = null

  const check = async (): Promise<void> => {
    let latest: string
    const cache = readUpdateCache(options.dataDir)
    if (cache && now() - cache.checkedAt < intervalMs) {
      latest = cache.latest
    } else {
      try {
        latest = await fetchLatest()
      } catch {
        return // offline or npm down: the next check tries again
      }
      try {
        writeUpdateCache(options.dataDir, { checkedAt: now(), latest })
      } catch {
        // the notice works without the cache
      }
    }
    if (!isNewer(latest, options.current) || latest === announced) return
    announced = latest
    options.log(updateAvailableLine(latest, options.current, method, options.running))
  }

  if (updateChecksDisabled(env) || !NOTIFY_KINDS.has(method.kind)) {
    return { check: async () => {}, stop: () => {} }
  }
  void check()
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => { void check() }, intervalMs)
  timer.unref?.()
  return {
    check,
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
