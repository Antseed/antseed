import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, useToast } from '@antseed/ui'
import { api } from '../api'
import type { GatewayUpdate } from '../api/types'
import { useConsole } from '../app/context'
import { formatElapsed, formatRelative } from '../lib/format'
import { useConsoleMutation } from '../lib/mutations'
import { qk, useUpdate } from '../lib/queries'
import { isOrgAdmin } from '../lib/nav'
import { href, navigate } from '../lib/router'
import {
  noticeVersion,
  readDismissedUpdate,
  readyVersion,
  recentUpdateResult,
  rememberDismissedUpdate,
  showUpdateNotice,
  updateInFlight,
  updatePhase,
  updateProgressView,
  updateReconnecting,
  updateRestarting,
  updateTook,
  type UpdateProgressView,
} from '../lib/update'
import { useNow } from '../lib/use-now'
import { Badge, CodeBlock, ConfirmDialog, DetailList, ErrorAlert, Panel, QueryView } from './ui'
import '../styles/update.scss'

/** What an update installs, as people know it. */
function productName(update: GatewayUpdate): string {
  return update.product === 'desktop' ? 'Antseed Desktop' : 'Antseed'
}

/**
 * The update status, polled every 2 s while an update runs, with a clock for
 * its elapsed timer. The gateway goes away mid-update (it serves this page),
 * so a failed or stuck poll then reads as "restarting", not as an error.
 */
function useUpdateStatus(enabled = true) {
  const update = useUpdate(enabled)
  const now = useNow(updateInFlight(update.data), 1_000)
  const reconnecting = updateReconnecting(update.data, update, now)
  const view = updateProgressView(update.data, { reconnecting })
  return { update, now, view }
}

/** Restart & update's steps as a thin segmented line: done, current, to come. */
function StepBar({ step, steps }: { step: number; steps: number }) {
  return (
    <div className="gc-update-steps" role="progressbar" aria-label="Update progress" aria-valuemin={1} aria-valuemax={steps} aria-valuenow={step}
      aria-valuetext={`Step ${step} of ${steps}`}>
      {Array.from({ length: steps }, (_, index) => (
        <span key={index} className={index + 1 < step ? 'gc-update-steps__step gc-update-steps__step--done'
          : index + 1 === step ? 'gc-update-steps__step gc-update-steps__step--current' : 'gc-update-steps__step'} />
      ))}
    </div>
  )
}

/** Settings → Updates while an update runs: the step, what it does, how far along, and for how long. */
function UpdateProgress({ view, now }: { view: UpdateProgressView; now: number }) {
  const stepTime = view.stepStartedAt !== null && view.stepMaxMs !== null && !view.reconnecting
    ? `This step: ${formatElapsed(now - view.stepStartedAt)} of up to ${formatElapsed(view.stepMaxMs)}`
    : null
  return (
    <div className="gc-update-progress">
      <p className="gc-update-progress__line">
        <span className="gc-attention" aria-hidden="true" />
        <span className="gc-strong" aria-live="polite">{view.title}</span>
        {view.step !== null && <span className="gc-muted">Step {view.step} of {view.steps}</span>}
        <span className="gc-update-progress__time" role="timer" aria-live="off" aria-label="Elapsed">{formatElapsed(now - view.startedAt)}</span>
      </p>
      {view.step !== null && <StepBar step={view.step} steps={view.steps} />}
      <p className="gc-muted" aria-live="polite">{view.detail}</p>
      {stepTime && <p className="gc-muted gc-update-progress__step-time">{stepTime}</p>}
    </div>
  )
}

/**
 * Reloads the console once the gateway comes back on a new version after an
 * update this page watched, so the new console code is the one running.
 */
function useReloadAfterUpdate(update: GatewayUpdate | undefined) {
  const toast = useToast()
  const watched = useRef<string | null>(null)
  useEffect(() => {
    if (!update) return
    if (updateRestarting(update)) {
      watched.current ??= update.current
      return
    }
    if (watched.current && update.current !== watched.current) {
      watched.current = null
      toast(`Updated to ${productName(update)} ${update.current}. Reloading…`)
      const timer = window.setTimeout(() => window.location.reload(), 1_500)
      return () => window.clearTimeout(timer)
    }
  }, [update, toast])
}

/** The two steps, as on the desktop app's banner: Download, then Restart & update. */
function useUpdateActions() {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const download = useConsoleMutation({
    mutationFn: () => api.update.apply('download'),
    onSuccess: (data) => queryClient.setQueryData(qk.update, data),
  })
  const install = useConsoleMutation({
    mutationFn: () => api.update.apply('install'),
    onSuccess: (data) => { setConfirming(false); queryClient.setQueryData(qk.update, data) },
  })
  return { download, install, confirming, setConfirming }
}

function RestartDialog({ update, actions }: { update: GatewayUpdate | undefined; actions: ReturnType<typeof useUpdateActions> }) {
  const version = update ? readyVersion(update) ?? update.latest : null
  return (
    <ConfirmDialog isOpen={actions.confirming} busy={actions.install.isPending} error={actions.install.error}
      onClose={() => actions.setConfirming(false)} onConfirm={() => actions.install.mutate()}
      title={`Restart on ${update ? productName(update) : 'Antseed'} ${version ?? ''}?`} confirmLabel="Restart & update"
      body={update?.product === 'desktop'
        ? 'The desktop app restarts into the new release. The gateway is unreachable while the app restarts, usually under a minute, and requests sent meanwhile fail. This page reloads by itself when the gateway is back.'
        : 'The buyer and the gateway restart one at a time on the new version. Requests in flight get up to a minute to finish, and new ones wait instead of failing, except through a Cloudflare tunnel while the gateway itself restarts (a few seconds). If the new version does not start, the server goes back to this one.'} />
  )
}

function openSettings(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate('settings')
}

/**
 * One calm line above every page for owners and admins while a newer Antseed
 * is out, downloaded or installing, with the same two steps as the desktop
 * app: Download, then Restart & update. `quiet` hides the line (on
 * Settings, which shows the full panel) but still reloads the page after an
 * update.
 */
export function UpdateNotice({ quiet = false }: { quiet?: boolean }) {
  const { viewer } = useConsole()
  const admin = isOrgAdmin(viewer)
  const { update, now, view } = useUpdateStatus(admin)
  const actions = useUpdateActions()
  const [dismissed, setDismissed] = useState(readDismissedUpdate)
  useReloadAfterUpdate(update.data)
  const data = update.data
  if (quiet || !data || !showUpdateNotice(viewer, data, dismissed)) return null
  const phase = updatePhase(data)
  const name = productName(data)
  const result = recentUpdateResult(data)
  const dismiss = (
    <button type="button" className="gc-update-notice__link" onClick={() => { const version = noticeVersion(data)!; rememberDismissedUpdate(version); setDismissed(version) }}>Dismiss</button>
  )
  const details = <a className="gc-update-notice__link" href={href('settings')} onClick={openSettings}>Details</a>
  let dot = 'gc-attention'
  let line: ReactNode
  if (view) {
    const to = data.progress?.to ?? data.latest
    const downloadOnly = data.progress?.action === 'download'
    const what = downloadOnly ? `Downloading ${name} ${to ?? ''}` : `Updating ${name}${to ? ` to ${to}` : ''}`
    // A download is one step, already named by `what`.
    const stepTitle = !view.reconnecting && (!downloadOnly || data.progress?.state === 'requested')
    line = (
      <>
        <span>{view.reconnecting ? view.title : what}</span>
        {stepTitle && <span className="gc-update-notice__step">{view.title}</span>}
        {view.step !== null && <span className="gc-update-notice__step">Step {view.step} of {view.steps}</span>}
        <span className="gc-update-notice__time" role="timer" aria-live="off" aria-label="Elapsed">{formatElapsed(now - view.startedAt)}</span>
        {view.reconnecting && <span className="gc-update-notice__step">This page reconnects by itself</span>}
        {!view.reconnecting && details}
      </>
    )
  } else if (result === 'succeeded') {
    dot = 'gc-update-done'
    const took = updateTook(data)
    line = (
      <>
        <span>Updated {name} from {data.progress?.from ?? 'the previous version'} to {data.progress?.to}{took !== null ? ` in ${formatElapsed(took)}` : ''}.</span>
        {dismiss}
      </>
    )
  } else if (result === 'failed' && phase === 'failed') {
    line = (
      <>
        <span>The update to {data.progress?.to ?? data.latest} failed: {data.progress?.error ?? 'unknown error'}. This gateway still runs {data.current}.</span>
        {data.apply === 'console' && <button type="button" className="gc-update-notice__link" disabled={actions.download.isPending} onClick={() => actions.download.mutate()}>Try again</button>}
        {details}
        {dismiss}
      </>
    )
  } else if (phase === 'ready') {
    line = (
      <>
        <span>{name} {readyVersion(data)} is downloaded and ready to install.</span>
        <button type="button" className="gc-update-notice__link" onClick={() => actions.setConfirming(true)}>Restart &amp; update</button>
        {dismiss}
      </>
    )
  } else {
    line = (
      <>
        <span>{name} {data.latest} is available. This gateway runs {data.current}.</span>
        {data.apply === 'console'
          ? <button type="button" className="gc-update-notice__link" disabled={actions.download.isPending} onClick={() => actions.download.mutate()}>Download</button>
          : <a className="gc-update-notice__link" href={href('settings')} onClick={openSettings}>Update</a>}
        {dismiss}
      </>
    )
  }
  return (
    <>
      <p className="gc-update-notice" role="status">
        <span className={dot} aria-hidden="true" />
        {line}
      </p>
      <RestartDialog update={data} actions={actions} />
    </>
  )
}

function VersionBadge({ update }: { update: GatewayUpdate }) {
  const ready = readyVersion(update)
  if (ready) return <Badge tone="warning">{ready} ready to install</Badge>
  if (update.available) return <Badge tone="warning">{update.latest} available</Badge>
  if (update.latest) return <Badge tone="success">Up to date</Badge>
  return <Badge>Not checked</Badge>
}

function ProgressLine({ update, view, now }: { update: GatewayUpdate; view: UpdateProgressView | null; now: number }) {
  const phase = updatePhase(update, now)
  const desktop = update.product === 'desktop'
  if (view && phase !== 'stalled') return <UpdateProgress view={view} now={now} />
  if (phase === 'ready') {
    const ready = readyVersion(update)
    const newer = update.latest && update.latest !== ready ? ` ${update.latest} came out since; download it after this update.` : ''
    return <p className="gc-muted">{desktop
      ? `Antseed Desktop ${ready} is downloaded. Restart & update restarts the app into it.${newer}`
      : `@antseed/cli ${ready} is downloaded. Restart & update restarts the buyer and the gateway on it, one at a time, while requests wait for them.${newer}`}</p>
  }
  if (phase === 'stalled' && desktop) {
    return (
      <p className="gc-override"><span className="gc-attention" aria-hidden="true" />
        The desktop app has not picked this up. Update it from the app on that computer instead.</p>
    )
  }
  if (phase === 'failed' && desktop) {
    return (
      <p className="gc-override"><span className="gc-attention" aria-hidden="true" />
        The last update failed: {update.progress?.error ?? 'unknown error'}. The app's log has the details.</p>
    )
  }
  if (phase === 'stalled') {
    return (
      <p className="gc-override"><span className="gc-attention" aria-hidden="true" />
        The update service has not picked this up. On the server, check <code>systemctl status antseed-update.path</code>; servers installed before it existed need the installer re-run once.</p>
    )
  }
  if (phase === 'failed') {
    return (
      <p className="gc-override"><span className="gc-attention" aria-hidden="true" />
        <span>The last update failed: {update.progress?.error ?? 'unknown error'}. This gateway still runs {update.current}. Download again to retry; if it fails again, see <code>journalctl -u antseed-update</code> on the server.</span></p>
    )
  }
  const took = updateTook(update)
  if (update.progress?.state === 'succeeded' && update.progress.action === 'install' && update.progress.from && update.progress.to && update.progress.from !== update.progress.to) {
    return (
      <p className="gc-override"><span className="gc-update-done" aria-hidden="true" />
        <span>Updated from {update.progress.from} to {update.progress.to} {formatRelative(update.progress.finishedAt, now)}{took !== null ? `, in ${formatElapsed(took)}` : ''}.</span></p>
    )
  }
  return null
}

/** Settings → General: the running version, the latest one, and the way to update this gateway. */
export function UpdatePanel() {
  const queryClient = useQueryClient()
  const { update, now, view } = useUpdateStatus()
  const actions = useUpdateActions()
  const check = useConsoleMutation({
    mutationFn: () => api.update.check(),
    onSuccess: (data) => queryClient.setQueryData(qk.update, data),
  })
  // Mid-update the gateway is away for a while; keep showing the update, not an error.
  const query = updateRestarting(update.data) ? { data: update.data, error: null, isLoading: false, refetch: update.refetch } : update
  return (
    <Panel title="Updates" description={update.data?.product === 'desktop'
      ? 'This gateway runs in Antseed Desktop, which checks for new releases every 30 minutes. Nothing installs until you choose to.'
      : 'The gateway asks npm for the latest @antseed/cli every 30 minutes. Nothing installs until you choose to.'}>
      <QueryView query={query}>
        {(data) => {
          const inFlight = updateInFlight(data)
          const phase = updatePhase(data, now)
          return (
            <div className="gc-stack">
              <DetailList items={[
                ['Running', <span key="v" className="gc-update__version">{data.current} <VersionBadge update={data} /></span>],
                [data.product === 'desktop' ? 'Latest release' : 'Latest on npm', data.latest ?? '—'],
                ['Last checked', data.checkError
                  ? <span key="c" className="gc-override"><span className="gc-attention" aria-hidden="true" />{data.product === 'desktop' ? 'Could not check' : 'Could not reach npm'} {formatRelative(data.checkedAt)}: {data.checkError}</span>
                  : formatRelative(data.checkedAt)],
              ]} />
              <ProgressLine update={data} view={view} now={now} />
              {data.available && !inFlight && data.apply === 'command' && data.command && (
                <div className="gc-stack">
                  <p className="gc-muted">{data.note} Update it on the gateway host, then restart the gateway:</p>
                  <CodeBlock code={data.command} label="Gateway host" />
                </div>
              )}
              {data.available && data.apply === 'none' && <p className="gc-muted">{data.note}</p>}
              {check.error ? <ErrorAlert error={check.error} title="Could not check for updates" /> : null}
              {actions.download.error ? <ErrorAlert error={actions.download.error} title="Could not start the download" /> : null}
              <div className="gc-actions gc-actions--start">
                {data.apply === 'console' && (phase === 'available' || phase === 'failed') && (
                  <Button disabled={actions.download.isPending} onClick={() => actions.download.mutate()}>Download {data.latest}</Button>
                )}
                {data.apply === 'console' && phase === 'downloading' && <Button disabled>Downloading…</Button>}
                {data.apply === 'console' && phase === 'ready' && (
                  <Button onClick={() => actions.setConfirming(true)}>Restart &amp; update</Button>
                )}
                <Button variant="outline" disabled={check.isPending || inFlight} onClick={() => check.mutate()}>
                  {check.isPending ? 'Checking…' : 'Check now'}
                </Button>
              </div>
            </div>
          )
        }}
      </QueryView>
      <RestartDialog update={update.data} actions={actions} />
    </Panel>
  )
}

/**
 * The seller dashboard's notice: a newer Antseed and how this seller gets it.
 * The page never installs it (the seller runs elsewhere: a service, a
 * container), so it shows the command or the note, until dismissed.
 */
export function SellerUpdateNotice() {
  const update = useUpdate()
  const [dismissed, setDismissed] = useState(readDismissedUpdate)
  const data = update.data
  if (!data?.available || !data.latest || data.latest === dismissed) return null
  const latest = data.latest
  return (
    <p className="gc-update-notice" role="status">
      <span className="gc-attention" aria-hidden="true" />
      <span>Antseed {latest} is available. This seller runs {data.current}.</span>
      {data.command
        ? <span>Run <code>{data.command}</code> where it runs, then restart it.</span>
        : <span>{data.note}</span>}
      <button type="button" className="gc-update-notice__link" onClick={() => { rememberDismissedUpdate(latest); setDismissed(latest) }}>Dismiss</button>
    </p>
  )
}
