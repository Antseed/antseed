import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isSemver } from './version.js'

/**
 * The gateway installer runs the CLI as an unprivileged `antseed` user that
 * cannot write its own install (`/opt/antseed`, root-owned). It installs a
 * root `antseed-update.service` started by a systemd path unit whenever
 * the request file appears, and tells the CLI both paths:
 *
 * - `ANTSEED_UPDATER_REQUEST`: a file in the `antseed` user's home. Its
 *   existence is the request; the updater deletes it and installs
 *   `@antseed/cli@latest` (never a version named in the file). The file's
 *   `action` only picks the step, the way the desktop app splits them:
 *   `download` installs the new version next to the running one and stops
 *   (`ready`); `install` (the default) also switches to it and restarts the
 *   buyer and gateway services.
 * - `ANTSEED_UPDATER_STATUS`: JSON the updater writes in a root-owned
 *   directory, so the `antseed` user can read but not forge it.
 */
export interface RootUpdaterPaths {
  request: string
  status: string
}

export type RootUpdateState = 'requested' | 'running' | 'ready' | 'succeeded' | 'failed'

/** `download` fetches the new version; `install` switches to it and restarts. */
export type RootUpdateAction = 'download' | 'install'

/**
 * The step a running update is on, in the order an install takes them
 * (`download` stops after `downloading`). `rolling-back` replaces the rest
 * when the new version does not come up. The gateway serves the console,
 * so the console cannot reach it from `draining-gateway` until it answers again.
 */
export type RootUpdatePhase =
  | 'downloading'       // npm installs the new version next to the running one
  | 'restarting-buyer'  // the buyer drains and starts on it; the gateway holds requests meanwhile
  | 'draining-gateway'  // the gateway stops taking requests and lets those in flight finish
  | 'starting-gateway'  // the new gateway starts
  | 'checking'          // waiting for the new gateway to answer
  | 'rolling-back'      // going back to the previous version

export const ROOT_UPDATE_PHASES: readonly RootUpdatePhase[] = [
  'downloading', 'restarting-buyer', 'draining-gateway', 'starting-gateway', 'checking', 'rolling-back',
]

export interface RootUpdateProgress {
  state: RootUpdateState
  action: RootUpdateAction
  /** Version before the update; null while only requested. */
  from: string | null
  /** Version downloaded (ready) or installed (succeeded); null until then. */
  to: string | null
  /** When the request was made (requested) or the updater started (otherwise). */
  startedAt: number
  finishedAt: number | null
  /** Why it failed, in one line; details are in `journalctl -u antseed-update`. */
  error: string | null
  /**
   * While running: the step it is on. Absent from updaters written before
   * steps were reported (re-running the installer adds them) and from the
   * desktop app's.
   */
  phase?: RootUpdatePhase
  /** When `phase` started (ms). */
  phaseStartedAt?: number
  /** The longest `phase` can take, when bounded (the gateway's drain: its systemd stop timeout). */
  phaseMaxMs?: number
}

/**
 * The desktop app runs the gateway too (its public tunnel) and answers the
 * same request with its own updater (`ANTSEED_UPDATER_KIND=desktop`). It
 * updates the whole app, not the CLI, so it writes the app's versions into
 * the status file as `app`, and those are the versions the console shows.
 */
export interface UpdaterAppVersions {
  /** The running app version. */
  current: string
  /** The newest release the app knows of; null before its first check. */
  latest: string | null
  checkedAt: number | null
  error: string | null
}

export function readUpdaterAppVersions(paths: RootUpdaterPaths): UpdaterAppVersions | null {
  try {
    const app = (JSON.parse(readFileSync(paths.status, 'utf8')) as Record<string, unknown>)['app'] as Record<string, unknown> | undefined
    if (!app || !isSemver(app['current'])) return null
    return {
      current: app['current'],
      latest: isSemver(app['latest']) ? app['latest'] : null,
      checkedAt: typeof app['checkedAt'] === 'number' ? app['checkedAt'] : null,
      error: typeof app['error'] === 'string' ? app['error'].slice(0, 500) : null,
    }
  } catch {
    return null
  }
}

export function rootUpdaterPaths(env: NodeJS.ProcessEnv = process.env): RootUpdaterPaths | null {
  const request = env['ANTSEED_UPDATER_REQUEST']?.trim()
  const status = env['ANTSEED_UPDATER_STATUS']?.trim()
  return request && status ? { request, status } : null
}

/**
 * Asks the root updater for `@antseed/cli@latest`. Writing the file is all it
 * takes; it appears whole (written aside, then renamed), since the updater
 * starts the moment the path exists.
 */
export function requestRootUpdate(paths: RootUpdaterPaths, requestedBy: string, now = Date.now(), action: RootUpdateAction = 'install'): void {
  const temp = `${paths.request}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ requestedAt: now, requestedBy, action })}\n`, { mode: 0o644 })
  try {
    renameSync(temp, paths.request)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * Asks the desktop app's updater to check for a release now. A separate file
 * from the update request, so a check is never read as an install.
 */
export function requestDesktopUpdateCheck(paths: RootUpdaterPaths): void {
  writeFileSync(`${paths.request}.check`, '', { mode: 0o644 })
}

function readAction(value: unknown): RootUpdateAction {
  return value === 'download' ? 'download' : 'install'
}

const STATES: ReadonlySet<string> = new Set(['running', 'ready', 'succeeded', 'failed'])

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** A running update's step, when its updater reports a known one; nothing otherwise. */
function readPhase(raw: Record<string, unknown>): Pick<RootUpdateProgress, 'phase' | 'phaseStartedAt' | 'phaseMaxMs'> {
  const phase = raw['phase']
  if (typeof phase !== 'string' || !(ROOT_UPDATE_PHASES as readonly string[]).includes(phase)) return {}
  const startedAt = raw['phaseStartedAt']
  const maxMs = raw['phaseMaxMs']
  return {
    phase: phase as RootUpdatePhase,
    ...(isTime(startedAt) ? { phaseStartedAt: startedAt } : {}),
    ...(isTime(maxMs) && maxMs > 0 ? { phaseMaxMs: maxMs } : {}),
  }
}

/**
 * The gateway server's update service gives up after 15 minutes
 * (`TimeoutStartSec`); a run still "running" well past that was cut off
 * (a reboot, a kill) and would otherwise block every later update.
 */
export const ROOT_UPDATE_STALE_MS = 20 * 60_000

/**
 * The pending request, else the updater's last run; null when it never ran.
 * With `staleAfterMs`, a run that has been "running" longer reads as failed.
 */
export function readRootUpdateProgress(
  paths: RootUpdaterPaths,
  options: { staleAfterMs?: number; now?: number } = {},
): RootUpdateProgress | null {
  if (existsSync(paths.request)) {
    let startedAt = Date.now()
    try {
      startedAt = statSync(paths.request).mtimeMs
    } catch {
      // picked up just now
    }
    let action: RootUpdateAction = 'install'
    try {
      action = readAction((JSON.parse(readFileSync(paths.request, 'utf8')) as Record<string, unknown>)['action'])
    } catch {
      // an empty or older request installs
    }
    return { state: 'requested', action, from: null, to: null, startedAt: Math.floor(startedAt), finishedAt: null, error: null }
  }
  try {
    const raw = JSON.parse(readFileSync(paths.status, 'utf8')) as Record<string, unknown>
    if (typeof raw['state'] !== 'string' || !STATES.has(raw['state']) || typeof raw['startedAt'] !== 'number') return null
    const progress: RootUpdateProgress = {
      state: raw['state'] as RootUpdateState,
      action: readAction(raw['action']),
      from: isSemver(raw['from']) ? raw['from'] : null,
      to: isSemver(raw['to']) ? raw['to'] : null,
      startedAt: raw['startedAt'],
      finishedAt: typeof raw['finishedAt'] === 'number' ? raw['finishedAt'] : null,
      error: typeof raw['error'] === 'string' ? raw['error'].slice(0, 500) : null,
      ...(raw['state'] === 'running' ? readPhase(raw) : {}),
    }
    const stale = options.staleAfterMs !== undefined && progress.state === 'running'
      && (options.now ?? Date.now()) - progress.startedAt > options.staleAfterMs
    if (!stale) return progress
    const { phase: _phase, phaseStartedAt: _phaseStartedAt, phaseMaxMs: _phaseMaxMs, ...run } = progress
    return { ...run, state: 'failed', error: 'the update service stopped before finishing' }
  } catch {
    return null
  }
}

/** A request or run that has not finished. */
export function updateInFlight(progress: RootUpdateProgress | null): boolean {
  return progress?.state === 'requested' || progress?.state === 'running'
}
