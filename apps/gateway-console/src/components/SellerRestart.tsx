import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, ConfirmDialog, useToast } from '@antseed/ui'
import { api } from '../api'
import type { SellerRestartView, SellerSettings } from '../api/types'
import { qk } from '../lib/queries'

/** How long a restart may take before the page says to check the seller's logs. */
const RESTART_TIMEOUT_MS = 3 * 60_000
const POLL_MS = 2_000

/**
 * Restarts the seller from the dashboard so saved settings apply. Offered only
 * where a supervisor (Kubernetes, systemd) starts the seller again; the page
 * then waits for the new run and reloads its data.
 */
export function SellerRestart({ restart, pending, onRestarted }: { restart: SellerRestartView; pending: boolean; onRestarted?: () => void }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'slow'>('idle')
  const cancelled = useRef(false)
  useEffect(() => {
    cancelled.current = false
    return () => { cancelled.current = true }
  }, [])

  const run = useMutation({
    mutationFn: async () => {
      const before = await api.seller.status().then((status) => (status.available ? status.startedAt : null), () => null)
      await api.seller.restart()
      return before
    },
    onSuccess: (before) => {
      setConfirming(false)
      setPhase('restarting')
      const started = Date.now()
      const poll = async () => {
        if (cancelled.current) return
        // While the seller is down this fails; a new run has a later start time.
        const status = await api.seller.status().catch(() => null)
        if (status?.available && status.running && status.startedAt !== null && status.startedAt !== before) {
          setPhase('idle')
          onRestarted?.()
          await queryClient.invalidateQueries({ queryKey: ['seller'] })
          toast('Seller restarted with the saved settings.')
          return
        }
        if (Date.now() - started > RESTART_TIMEOUT_MS) setPhase('slow')
        setTimeout(() => void poll(), POLL_MS)
      }
      setTimeout(() => void poll(), POLL_MS)
    },
  })

  if (phase !== 'idle') {
    return (
      <p className="gc-seller-notice" role="status">
        <span className="gc-attention" aria-hidden="true" />
        {phase === 'restarting'
          ? 'Restarting the seller. This page reconnects when it is back.'
          : 'The seller is taking longer than usual to come back. Check its logs where it runs.'}
      </p>
    )
  }
  if (!restart.available) {
    return pending ? <p className="gc-seller-notice" role="status"><span className="gc-attention" aria-hidden="true" />Saved. {restart.reason}</p> : null
  }
  return (
    <>
      <p className="gc-seller-notice" role="status">
        {pending && <span className="gc-attention" aria-hidden="true" />}
        {pending ? 'Saved. The seller applies it when it restarts. ' : null}
        <Button size="sm" variant="link" className="gc-seller-inline-button" onClick={() => setConfirming(true)}>Restart seller</Button>
      </p>
      <ConfirmDialog isOpen={confirming} busy={run.isPending} error={run.error} onClose={() => { setConfirming(false); run.reset() }}
        onConfirm={() => run.mutate()} title="Restart the seller?" confirmLabel="Restart" busyLabel="Restarting…" tone="primary"
        body="It stops cleanly (open channels are settled first) and starts again with the saved settings, usually within a minute. Buyers route to other sellers meanwhile." />
    </>
  )
}

/** Where saves go when config.json is read-only, and the settings saved over it. */
export function SellerOverrides({ settings }: { settings: SellerSettings }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const reset = useMutation({
    mutationFn: api.seller.resetOverrides,
    onSuccess: (data) => {
      queryClient.setQueryData(qk.sellerSettings, data)
      setConfirming(false)
      toast('Removed. The seller uses config.json alone after its next restart.')
    },
  })
  if (settings.savesTo !== 'overrides' && settings.overridden.length === 0) return null
  const count = settings.overridden.length
  return (
    <>
      <p className="gc-fineprint">
        {count > 0
          ? <>{count} setting{count === 1 ? '' : 's'} saved here {count === 1 ? 'applies' : 'apply'} over {settings.configPath}: {settings.overridden.join(', ')}. </>
          : <>{settings.configPath} cannot be written here, so changes are saved in {settings.overridesPath} and apply over it. </>}
        {count > 0 && settings.writable && <Button size="sm" variant="link" className="gc-seller-inline-button" onClick={() => setConfirming(true)}>Use config.json only</Button>}
      </p>
      <ConfirmDialog isOpen={confirming} busy={reset.isPending} error={reset.error} onClose={() => { setConfirming(false); reset.reset() }}
        onConfirm={() => reset.mutate()} title="Remove the saved settings?" confirmLabel="Remove" busyLabel="Removing…"
        body={`The ${count === 1 ? 'setting' : `${count} settings`} saved here are removed and ${settings.configPath} applies alone, from the seller's next restart.`} />
    </>
  )
}
