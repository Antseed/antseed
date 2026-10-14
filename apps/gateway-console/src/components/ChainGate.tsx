import { Suspense, type ReactNode } from 'react'
import type { ChainInfo } from '../api/types'
import { ErrorAlert, LoadingRows } from './ui'

/** Waits for the gateway's chain info, then renders the (lazily loaded) wallet UI that needs it. */
export function ChainGate({ chain, error, children }: { chain: ChainInfo | undefined; error?: unknown; children: (chain: ChainInfo) => ReactNode }) {
  if (error) return <ErrorAlert error={error} />
  if (!chain) return <LoadingRows rows={2} />
  return <Suspense fallback={<LoadingRows rows={2} />}>{children(chain)}</Suspense>
}
