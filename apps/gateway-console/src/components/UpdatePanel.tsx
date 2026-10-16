import { useEffect, useRef, useState, type MouseEvent } from 'react'
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
import { readDismissedUpdate, rememberDismissedUpdate, showUpdateNotice, updateInFlight, updatePhase } from '../lib/update'
import { Badge, CodeBlock, ConfirmDialog, DetailList, ErrorAlert, Panel, QueryView } from './ui'
import '../styles/update.scss'

/**
 * Reloads the console once the gateway comes back on a new version after an
 * update this page watched, so the new console code is the one running.
 */
function useReloadAfterUpdate(update: GatewayUpdate | undefined) {
  const toast = useToast()
  const watched = useRef<string | null>(null)
  useEffect(() => {
    if (!update) return
    if (updateInFlight(update)) {
      watched.current ??= update.current
      return
    }
    if (watched.current && update.current !== watched.current) {
      watched.current = null
      toast(`Updated to Antseed ${update.current}. Reloading…`)
      const timer = window.setTimeout(() => window.location.reload(), 1_500)
      return () => window.clearTimeout(timer)
    }
  }, [update, toast])
}

function openSettings(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate('settings')
}

/**
 * One calm line above every page for owners and admins while a newer Antseed
 * is out or an update runs. `quiet` hides the line (on Settings, which shows
 * the full panel) but still reloads the page after an update.
 */
export function UpdateNotice({ quiet = false }: { quiet?: boolean }) {
  const { viewer } = useConsole()
  const admin = isOrgAdmin(viewer)
  const update = useUpdate(admin)
  const [dismissed, setDismissed] = useState(readDismissedUpdate)
  useReloadAfterUpdate(update.data)
  const data = update.data
  if (quiet || !data || !showUpdateNotice(viewer, data, dismissed)) return null
  if (updateInFlight(data)) {
    return (
      <p className="gc-update-notice" role="status">
        <span className="gc-attention" aria-hidden="true" />
        <span>Updating Antseed{data.latest ? ` to ${data.latest}` : ''}. The gateway restarts when it is done; this page reloads by itself.</span>
      </p>
    )
  }
  return (
    <p className="gc-update-notice" role="status">
      <span className="gc-attention" aria-hidden="true" />
      <span>Antseed {data.latest} is available. This gateway runs {data.current}.</span>
      <a className="gc-update-notice__link" href={href('settings')} onClick={openSettings}>Update</a>
      <button type="button" className="gc-update-notice__link" onClick={() => { rememberDismissedUpdate(data.latest!); setDismissed(data.latest) }}>Dismiss</button>
    </p>
  )
}

function VersionBadge({ update }: { update: GatewayUpdate }) {
  if (update.available) return <Badge tone="warning">{update.latest} available</Badge>
  if (update.latest) return <Badge tone="success">Up to date</Badge>
  return <Badge>Not checked</Badge>
}

function ProgressLine({ update }: { update: GatewayUpdate }) {
  const phase = updatePhase(update)
  if (phase === 'requested') return <p className="gc-muted">Waiting for the update service…</p>
  if (phase === 'running') return <p className="gc-muted">Installing @antseed/cli@latest. The buyer and gateway restart when it finishes, and this page reloads.</p>
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

/** Settings → General: the running version, npm's latest, and the way to update this gateway. */
export function UpdatePanel() {
  const queryClient = useQueryClient()
  const update = useUpdate()
  const [confirming, setConfirming] = useState(false)
  const check = useConsoleMutation({
    mutationFn: () => api.update.check(),
    onSuccess: (data) => queryClient.setQueryData(qk.update, data),
  })
  const apply = useConsoleMutation({
    mutationFn: () => api.update.apply(),
    onSuccess: (data) => { setConfirming(false); queryClient.setQueryData(qk.update, data) },
  })
  return (
    <Panel title="Updates" description="The gateway asks npm for the latest @antseed/cli a few times a day.">
      <QueryView query={update}>
        {(data) => {
          const inFlight = updateInFlight(data)
          return (
            <div className="gc-stack">
              <DetailList items={[
                ['Running', <span key="v" className="gc-update__version">{data.current} <VersionBadge update={data} /></span>],
                ['Latest on npm', data.latest ?? '—'],
                ['Last checked', data.checkError
                  ? <span key="c" className="gc-override"><span className="gc-attention" aria-hidden="true" />Could not reach npm {formatRelative(data.checkedAt)}: {data.checkError}</span>
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
              <div className="gc-actions gc-actions--start">
                {data.available && data.apply === 'console' && !inFlight && (
                  <Button onClick={() => setConfirming(true)}>Update to {data.latest}</Button>
                )}
                <Button variant="outline" disabled={check.isPending || inFlight} onClick={() => check.mutate()}>
                  {check.isPending ? 'Checking…' : 'Check now'}
                </Button>
              </div>
            </div>
          )
        }}
      </QueryView>
      <ConfirmDialog isOpen={confirming} busy={apply.isPending} error={apply.error} onClose={() => setConfirming(false)}
        onConfirm={() => apply.mutate()} title={`Update to Antseed ${update.data?.latest ?? ''}?`} confirmLabel="Update and restart"
        body="The server installs the latest @antseed/cli, then restarts the buyer and the gateway. Requests in flight are cut off and the console is unreachable for about a minute; it reloads by itself when the gateway is back." />
    </Panel>
  )
}
