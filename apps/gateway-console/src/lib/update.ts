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

/** The downloaded version waiting for Restart & update, even when npm has a newer one since. */
export function readyVersion(update: GatewayUpdate): string | null {
  return update.downloaded ?? null
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

/** Owners and admins see the notice for a newer version until they dismiss that version, and the result of a recent update. */
export function showUpdateNotice(viewer: Viewer, update: GatewayUpdate | undefined, dismissedVersion: string | null, now = Date.now()): boolean {
  if (!update || !isOrgAdmin(viewer) || update.apply === 'none') return false
  if (updateInFlight(update)) return true
  if (recentUpdateResult(update, now) === 'succeeded') return noticeVersion(update, now) !== dismissedVersion
  return (update.available || readyVersion(update) !== null) && noticeVersion(update, now) !== dismissedVersion
}

/**
 * The version the notice is about, and the one Dismiss hides it for: the one
 * just installed, else the downloaded one, else npm's latest.
 */
export function noticeVersion(update: GatewayUpdate, now = Date.now()): string | null {
  if (recentUpdateResult(update, now) === 'succeeded') return update.progress?.to ?? null
  return readyVersion(update) ?? update.latest
}

// ── Progress while an update runs ──

type RunPhase = NonNullable<NonNullable<GatewayUpdate['progress']>['phase']>

/** Restart & update's steps, in order, as the server's updater reports them. */
export const INSTALL_STEPS: readonly RunPhase[] = ['downloading', 'restarting-buyer', 'draining-gateway', 'starting-gateway', 'checking']

/** How long a restarting gateway may go without answering a poll (every 2 s) before the console says it is restarting. */
export const UPDATE_RECONNECT_AFTER_MS = 7_000
/** How long the notice above every page reports a finished update. */
export const UPDATE_RESULT_NOTICE_MS = 15 * 60_000

export interface UpdateProgressView {
  /** The step, in a few words. */
  title: string
  /** One line on what happens in it. */
  detail: string
  /** Its place among Restart & update's steps (1-based); null when the updater reports no steps, or off the usual path (rolling back). */
  step: number | null
  steps: number
  /** When the whole run started (ms), for the elapsed timer. */
  startedAt: number
  /** When this step started and the longest it can take, when the updater says. */
  stepStartedAt: number | null
  stepMaxMs: number | null
  /** The gateway stopped answering mid-update; the page keeps polling until it is back. */
  reconnecting: boolean
}

/** A bound as people say it: "90s", "2 min". */
export function formatBound(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)} min`
}

/**
 * Whether the gateway went quiet during an update that restarts it: the last
 * poll failed, or none has come back for a while (a proxy in front, such as
 * Caddy, can hold requests until the new gateway is up rather than fail them).
 */
export function updateReconnecting(update: GatewayUpdate | undefined, query: { error: unknown; dataUpdatedAt: number }, now = Date.now()): boolean {
  if (!updateRestarting(update)) return false
  return Boolean(query.error) || now - query.dataUpdatedAt > UPDATE_RECONNECT_AFTER_MS
}

function stepCopy(update: GatewayUpdate, phase: RunPhase, maxMs: number | null): { title: string; detail: string } {
  const to = update.progress?.to ?? update.latest ?? 'the new version'
  const from = update.progress?.from ?? 'the previous version'
  const upTo = maxMs ? ` This can take up to ${formatBound(maxMs)}.` : ''
  switch (phase) {
    case 'downloading':
      return update.progress?.action === 'download'
        ? { title: `Downloading ${to}`, detail: `npm installs @antseed/cli ${to} next to the running version. The gateway keeps serving until you restart it.` }
        : { title: `Downloading ${to}`, detail: `npm installs @antseed/cli ${to} next to the running version. The gateway keeps serving meanwhile.` }
    case 'restarting-buyer':
      return { title: 'Restarting the buyer', detail: `The buyer finishes its requests and starts on ${to}. The gateway holds new requests for it, so they wait instead of failing.${upTo}` }
    case 'draining-gateway':
      return { title: 'Waiting for in-flight requests to finish', detail: `The gateway stops taking new requests and lets long responses complete before it restarts.${upTo || ' This can take up to a minute and a half.'}` }
    case 'starting-gateway':
      return { title: 'Starting the new gateway', detail: `The gateway starts on ${to}. This page reconnects by itself once it answers.${upTo}` }
    case 'checking':
      return { title: 'Checking the new version', detail: `Waiting for the gateway on ${to} to answer. If it does not, the server goes back to ${from}.` }
    case 'rolling-back':
      return { title: `Going back to ${from}`, detail: `${to} did not start, so the buyer and the gateway restart on the version that ran before.` }
  }
}

/** What to show while an update is requested or running; null when none is. */
export function updateProgressView(update: GatewayUpdate | undefined, options: { reconnecting?: boolean } = {}): UpdateProgressView | null {
  const progress = update?.progress
  if (!update || !progress || !updateInFlight(update)) return null
  const desktop = update.product === 'desktop'
  const to = progress.to ?? update.latest ?? ''
  const reconnecting = Boolean(options.reconnecting) && updateRestarting(update)
  const base = { startedAt: progress.startedAt, step: null, steps: INSTALL_STEPS.length, stepStartedAt: null, stepMaxMs: null, reconnecting }
  const phase = progress.state === 'running' && !desktop ? progress.phase : undefined
  let view: UpdateProgressView
  if (progress.state === 'requested') {
    view = { ...base, title: desktop ? 'Waiting for the desktop app' : 'Waiting for the update service', detail: desktop ? 'The app picks up the request within a few seconds.' : 'The server\'s update service picks up the request within a few seconds.' }
  } else if (phase) {
    const maxMs = progress.phaseMaxMs ?? null
    const index = progress.action === 'install' ? INSTALL_STEPS.indexOf(phase) : -1
    view = { ...base, ...stepCopy(update, phase, maxMs), step: index >= 0 ? index + 1 : null, stepStartedAt: progress.phaseStartedAt ?? null, stepMaxMs: maxMs }
  } else if (progress.action === 'download') {
    view = { ...base, title: `Downloading ${to}`, detail: desktop ? `Antseed Desktop ${to} downloads; the app keeps running until you restart it.` : `npm installs @antseed/cli ${to} next to the running version. The gateway keeps serving until you restart it.` }
  } else {
    // Updaters from older installers report no steps.
    view = { ...base, title: `Updating to ${to}`, detail: desktop ? 'The desktop app restarts into the new release. This page reloads once it is back.' : 'The buyer and the gateway restart one at a time while requests wait for them. This page reloads when it is done.' }
  }
  if (!reconnecting) return view
  return {
    ...view,
    title: desktop ? 'The app is restarting' : 'The gateway is restarting',
    detail: `This page reconnects by itself once it is back.${phase === 'draining-gateway' ? ` ${view.detail}` : ''}`,
  }
}

/** A Restart & update that finished within `UPDATE_RESULT_NOTICE_MS`: whether it worked. */
export function recentUpdateResult(update: GatewayUpdate | undefined, now = Date.now()): 'succeeded' | 'failed' | null {
  const progress = update?.progress
  if (!progress || progress.action !== 'install' || progress.finishedAt === null || now - progress.finishedAt > UPDATE_RESULT_NOTICE_MS) return null
  if (progress.state === 'succeeded' && progress.to && progress.from !== progress.to) return 'succeeded'
  return progress.state === 'failed' ? 'failed' : null
}

/** How long a finished run took, when it says. */
export function updateTook(update: GatewayUpdate | undefined): number | null {
  const progress = update?.progress
  return progress && progress.finishedAt !== null ? Math.max(0, progress.finishedAt - progress.startedAt) : null
}

/** Dismissal lasts per version in this browser: the next release shows the notice again. */
export function readDismissedUpdate(): string | null {
  try { return localStorage.getItem(DISMISS_KEY) } catch { return null }
}

export function rememberDismissedUpdate(version: string): void {
  try { localStorage.setItem(DISMISS_KEY, version) } catch { /* storage unavailable */ }
}
