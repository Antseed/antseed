import { useEffect } from 'react'
import { api, isApiError, type ApiClient } from '../api'

export const HEARTBEAT_MS = 60_000

/**
 * Drives the deposit watcher from page visibility: `active` now and every
 * minute while visible, `background` when hidden or stopped. A wallet the
 * buyer cannot watch (409) ends it. Returns a stop function.
 */
export function startDepositHeartbeat(workspaceId: string, client: Pick<ApiClient, 'wallet'>, doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> = document): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let active = false
  const send = (mode: 'active' | 'background') => {
    if (stopped) return
    active = mode === 'active'
    void client.wallet.watch(workspaceId, mode).catch((error: unknown) => {
      if (isApiError(error) && error.status === 409) stopped = true
    })
  }
  const start = () => {
    clearInterval(timer)
    send('active')
    timer = setInterval(() => send('active'), HEARTBEAT_MS)
  }
  const pause = () => {
    clearInterval(timer)
    if (active) send('background')
  }
  const onVisibility = () => (doc.visibilityState === 'hidden' ? pause() : start())
  if (doc.visibilityState !== 'hidden') start()
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility)
    pause()
    stopped = true
  }
}

/** Keeps the gateway's deposit watcher fast while the wallet page is open and visible. */
export function useDepositWatchHeartbeat(workspaceId: string) {
  useEffect(() => startDepositHeartbeat(workspaceId, api), [workspaceId])
}
