import { useEffect } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'

/**
 * Floor for re-fetching anything chain-backed (balances, rewards). The
 * gateway serves these from a cache, but each refresh can still cost a call
 * against a rate-limited public RPC, so never poll them faster.
 */
export const CHAIN_POLL_MS = 30_000

type VisibilityDoc = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>

type PollingOptions = {
  /** Floor for `intervalMs`; lower it only for data the gateway serves without a chain call per refresh. */
  minIntervalMs?: number
  doc?: VisibilityDoc
}

/**
 * Calls `refresh` every `intervalMs` (never faster than `minIntervalMs`) while
 * the page is visible. A hidden tab does not poll; it refreshes once when it
 * becomes visible again. Returns a stop function.
 */
export function startVisiblePolling(
  refresh: () => void,
  intervalMs: number = CHAIN_POLL_MS,
  { minIntervalMs = CHAIN_POLL_MS, doc = document }: PollingOptions = {},
): () => void {
  const every = Math.max(intervalMs, minIntervalMs)
  let timer: ReturnType<typeof setInterval> | undefined
  const start = () => {
    clearInterval(timer)
    timer = setInterval(refresh, every)
  }
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') {
      clearInterval(timer)
      timer = undefined
    } else {
      refresh()
      start()
    }
  }
  if (doc.visibilityState !== 'hidden') start()
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    clearInterval(timer)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}

/** Re-fetches a query every `intervalMs` (30 s or slower unless `minIntervalMs` says otherwise) while the tab is visible. */
export function useVisiblePolling(queryKey: QueryKey, intervalMs: number = CHAIN_POLL_MS, minIntervalMs: number = CHAIN_POLL_MS): void {
  const queryClient = useQueryClient()
  const key = JSON.stringify(queryKey)
  useEffect(
    () => startVisiblePolling(() => void queryClient.invalidateQueries({ queryKey: JSON.parse(key) as QueryKey }), intervalMs, { minIntervalMs }),
    [key, intervalMs, minIntervalMs, queryClient],
  )
}
