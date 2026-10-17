import type { GatewayUpdate } from '../api/types'
import { isOrgAdmin, type Viewer } from './nav'

const DISMISS_KEY = 'antseed-console-update-dismissed'
/** A request the update service has not picked up by then is stuck (its path unit is missing or stopped). */
export const UPDATE_PICKUP_MS = 60_000

export type UpdatePhase =
  | 'current'      // up to date, or never checked
  | 'available'    // a newer version: Download
  | 'requested'    // waiting for the update service (or the desktop app)
  | 'stalled'      // requested, but nothing picked it up
  | 'downloading'  // fetching the new version; the gateway keeps running
  | 'ready'        // downloaded: Restart & update
  | 'installing'   // switching to it and restarting
  | 'failed'       // the last run failed

/** The downloaded version waiting for Restart & update, if any. */
export function readyVersion(update: GatewayUpdate): string | null {
  const progress = update.progress
  return progress?.state === 'ready' && progress.to && progress.to === update.latest && update.available ? progress.to : null
}

export function updatePhase(update: GatewayUpdate, now = Date.now()): UpdatePhase {
  const progress = update.progress
  if (progress?.state === 'requested') return now - progress.startedAt > UPDATE_PICKUP_MS ? 'stalled' : 'requested'
  if (progress?.state === 'running') return progress.action === 'download' ? 'downloading' : 'installing'
  if (readyVersion(update)) return 'ready'
  if (progress?.state === 'failed' && update.available) return 'failed'
  return update.available ? 'available' : 'current'
}

export function updateInFlight(update: GatewayUpdate | undefined): boolean {
  return update?.progress?.state === 'requested' || update?.progress?.state === 'running'
}

/** Whether the running update restarts the gateway (the console then reloads), rather than only downloading. */
export function updateRestarting(update: GatewayUpdate | undefined): boolean {
  return updateInFlight(update) && update?.progress?.action !== 'download'
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
