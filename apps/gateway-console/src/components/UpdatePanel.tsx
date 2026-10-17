import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button, useToast } from '@antseed/ui'
import { api } from '../api'
import type { GatewayUpdate } from '../api/types'
import { useConsole } from '../app/context'
import { formatRelative } from '../lib/format'
import { useConsoleMutation } from '../lib/mutations'
import { qk, useUpdate } from '../lib/queries'
import { isOrgAdmin } from '../lib/nav'
import { href, navigate } from '../lib/router'
import {
  readDismissedUpdate,
  readyVersion,
  rememberDismissedUpdate,
  showUpdateNotice,
  updateInFlight,
  updatePhase,
  updateRestarting,
} from '../lib/update'
import { Badge, CodeBlock, ConfirmDialog, DetailList, ErrorAlert, Panel, QueryView } from './ui'
import '../styles/update.scss'

/** What an update installs, as people know it. */
function productName(update: GatewayUpdate): string {
  return update.product === 'desktop' ? 'Antseed Desktop' : 'Antseed'
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
  const update = useUpdate(admin)
  const actions = useUpdateActions()
  const [dismissed, setDismissed] = useState(readDismissedUpdate)
  useReloadAfterUpdate(update.data)
  const data = update.data
  if (quiet || !data || !showUpdateNotice(viewer, data, dismissed)) return null
  const phase = updatePhase(data)
  const name = productName(data)
  const dismiss = (
    <button type="button" className="gc-update-notice__link" onClick={() => { rememberDismissedUpdate(data.latest!); setDismissed(data.latest) }}>Dismiss</button>
  )
  let line: ReactNode
  if (phase === 'installing' || (phase === 'requested' && data.progress?.action !== 'download')) {
    line = <span>Updating {name}{data.latest ? ` to ${data.latest}` : ''}. {data.product === 'desktop' ? 'The app restarts' : 'The gateway restarts'} when it is done; this page reloads by itself.</span>
  } else if (phase === 'downloading' || phase === 'requested') {
    line = <span>Downloading {name} {data.latest}…</span>
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
        <span className="gc-attention" aria-hidden="true" />
        {line}
      </p>
      <RestartDialog update={data} actions={actions} />
    </>
  )
}

function VersionBadge({ update }: { update: GatewayUpdate }) {
  if (readyVersion(update)) return <Badge tone="warning">{update.latest} ready to install</Badge>
  if (update.available) return <Badge tone="warning">{update.latest} available</Badge>
  if (update.latest) return <Badge tone="success">Up to date</Badge>
  return <Badge>Not checked</Badge>
}

function ProgressLine({ update }: { update: GatewayUpdate }) {
  const phase = updatePhase(update)
  const desktop = update.product === 'desktop'
  const version = update.progress?.to ?? update.latest ?? ''
  if (phase === 'requested') return <p className="gc-muted">{desktop ? 'Waiting for the desktop app…' : 'Waiting for the update service…'}</p>
  if (phase === 'downloading') {
    return <p className="gc-muted">{desktop
      ? `Downloading Antseed Desktop ${version}. The app keeps running until you restart it.`
      : `Downloading @antseed/cli ${version} next to the running version. The gateway keeps serving until you restart it.`}</p>
  }
  if (phase === 'ready') {
    return <p className="gc-muted">{desktop
      ? `Antseed Desktop ${version} is downloaded. Restart & update restarts the app into it.`
      : `@antseed/cli ${version} is downloaded. Restart & update restarts the buyer and the gateway on it, one at a time, while requests wait for them.`}</p>
  }
  if (phase === 'installing') {
    return (
      <p className="gc-muted">{desktop
        ? `Restarting into Antseed Desktop ${version}. This page reloads once it is back.`
        : `Restarting the buyer and the gateway on ${version} one at a time, while requests wait for them. This page reloads when it is done.`}</p>
    )
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
        The last update failed: {update.progress?.error ?? 'unknown error'}. Details: <code>journalctl -u antseed-update</code></p>
    )
  }
  return null
}

/** Settings → General: the running version, the latest one, and the way to update this gateway. */
export function UpdatePanel() {
  const queryClient = useQueryClient()
  const update = useUpdate()
  const actions = useUpdateActions()
  const check = useConsoleMutation({
    mutationFn: () => api.update.check(),
    onSuccess: (data) => queryClient.setQueryData(qk.update, data),
  })
  return (
    <Panel title="Updates" description={update.data?.product === 'desktop'
      ? 'This gateway runs in Antseed Desktop, which checks for new releases every 30 minutes. Nothing installs until you choose to.'
      : 'The gateway asks npm for the latest @antseed/cli every 30 minutes. Nothing installs until you choose to.'}>
      <QueryView query={update}>
        {(data) => {
          const inFlight = updateInFlight(data)
          const phase = updatePhase(data)
          return (
            <div className="gc-stack">
              <DetailList items={[
                ['Running', <span key="v" className="gc-update__version">{data.current} <VersionBadge update={data} /></span>],
                [data.product === 'desktop' ? 'Latest release' : 'Latest on npm', data.latest ?? '—'],
                ['Last checked', data.checkError
                  ? <span key="c" className="gc-override"><span className="gc-attention" aria-hidden="true" />{data.product === 'desktop' ? 'Could not check' : 'Could not reach npm'} {formatRelative(data.checkedAt)}: {data.checkError}</span>
                  : formatRelative(data.checkedAt)],
              ]} />
              <ProgressLine update={data} />
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
