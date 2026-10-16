import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isSemver } from './version.js'

/**
 * The gateway installer runs the CLI as an unprivileged `antseed` user that
 * cannot write its own install (`/opt/antseed`, root-owned). It installs a
 * root `antseed-update.service` started by a systemd path unit whenever
 * the request file appears, and tells the CLI both paths:
 *
 * - `ANTSEED_UPDATER_REQUEST`: a file in the `antseed` user's home. Its
 *   existence is the whole request; the updater deletes it, installs
 *   `@antseed/cli@latest` (never a version named in the file) and restarts
 *   the buyer and gateway services.
 * - `ANTSEED_UPDATER_STATUS`: JSON the updater writes in a root-owned
 *   directory, so the `antseed` user can read but not forge it.
 */
export interface RootUpdaterPaths {
  request: string
  status: string
}

export type RootUpdateState = 'requested' | 'running' | 'succeeded' | 'failed'

export interface RootUpdateProgress {
  state: RootUpdateState
  /** Version before the update; null while only requested. */
  from: string | null
  /** Version installed; null until it succeeded. */
  to: string | null
  /** When the request was made (requested) or the updater started (otherwise). */
  startedAt: number
  finishedAt: number | null
  /** Why it failed, in one line; details are in `journalctl -u antseed-update`. */
  error: string | null
}

export function rootUpdaterPaths(env: NodeJS.ProcessEnv = process.env): RootUpdaterPaths | null {
  const request = env['ANTSEED_UPDATER_REQUEST']?.trim()
  const status = env['ANTSEED_UPDATER_STATUS']?.trim()
  return request && status ? { request, status } : null
}

/** Asks the root updater for `@antseed/cli@latest`. Writing the file is all it takes. */
export function requestRootUpdate(paths: RootUpdaterPaths, requestedBy: string, now = Date.now()): void {
  writeFileSync(paths.request, `${JSON.stringify({ requestedAt: now, requestedBy })}\n`, { mode: 0o644 })
}

const STATES: ReadonlySet<string> = new Set(['running', 'succeeded', 'failed'])

/** The pending request, else the updater's last run; null when it never ran. */
export function readRootUpdateProgress(paths: RootUpdaterPaths): RootUpdateProgress | null {
  if (existsSync(paths.request)) {
    let startedAt = Date.now()
    try {
      startedAt = statSync(paths.request).mtimeMs
    } catch {
      // picked up just now
    }
    return { state: 'requested', from: null, to: null, startedAt: Math.floor(startedAt), finishedAt: null, error: null }
  }
  try {
    const raw = JSON.parse(readFileSync(paths.status, 'utf8')) as Record<string, unknown>
    if (typeof raw['state'] !== 'string' || !STATES.has(raw['state']) || typeof raw['startedAt'] !== 'number') return null
    return {
      state: raw['state'] as RootUpdateState,
      from: isSemver(raw['from']) ? raw['from'] : null,
      to: isSemver(raw['to']) ? raw['to'] : null,
      startedAt: raw['startedAt'],
      finishedAt: typeof raw['finishedAt'] === 'number' ? raw['finishedAt'] : null,
      error: typeof raw['error'] === 'string' ? raw['error'].slice(0, 500) : null,
    }
  } catch {
    return null
  }
}

/** A request or run that has not finished. */
export function updateInFlight(progress: RootUpdateProgress | null): boolean {
  return progress?.state === 'requested' || progress?.state === 'running'
}
