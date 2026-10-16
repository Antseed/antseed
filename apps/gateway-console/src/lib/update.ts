import type { GatewayUpdate } from '../api/types'
import { isOrgAdmin, type Viewer } from './nav'

const DISMISS_KEY = 'antseed-console-update-dismissed'
/** A request the update service has not picked up by then is stuck (its path unit is missing or stopped). */
export const UPDATE_PICKUP_MS = 60_000

export type UpdatePhase =
  | 'current'      // up to date, or never checked
  | 'available'    // a newer version, nothing running
  | 'requested'    // waiting for the update service
  | 'stalled'      // requested, but nothing picked it up
  | 'running'      // installing
  | 'failed'       // the last run failed

export function updatePhase(update: GatewayUpdate, now = Date.now()): UpdatePhase {
  const progress = update.progress
  if (progress?.state === 'requested') return now - progress.startedAt > UPDATE_PICKUP_MS ? 'stalled' : 'requested'
  if (progress?.state === 'running') return 'running'
  if (progress?.state === 'failed' && update.available) return 'failed'
  return update.available ? 'available' : 'current'
}

export function updateInFlight(update: GatewayUpdate | undefined): boolean {
  return update?.progress?.state === 'requested' || update?.progress?.state === 'running'
}

/** Owners and admins see the notice for a newer version until they dismiss that version. */
export function showUpdateNotice(viewer: Viewer, update: GatewayUpdate | undefined, dismissedVersion: string | null): boolean {
  if (!update || !isOrgAdmin(viewer) || update.apply === 'none') return false
  if (updateInFlight(update)) return true
  return update.available && update.latest !== dismissedVersion
}

/** Dismissal lasts per version in this browser: the next release shows the notice again. */
export function readDismissedUpdate(): string | null {
  try { return localStorage.getItem(DISMISS_KEY) } catch { return null }
}

export function rememberDismissedUpdate(version: string): void {
  try { localStorage.setItem(DISMISS_KEY, version) } catch { /* storage unavailable */ }
}
