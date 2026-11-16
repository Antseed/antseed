import type { ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@antseed/ui'
import { errorMessage } from '../api/client'
import type { SellerNetworkMeta } from '../api/types'
import { formatRelative } from '../lib/format'
import { useSellerStatus } from '../lib/queries'
import type { AvailableSeller } from '../lib/seller'
import { Icon } from './icons'
import { EmptyState, ErrorAlert, LoadingRows, PageHeader } from './ui'

/** A Seller page frame: loads the seller's status and shows the page only when a seller is there. */
export function SellerPage({ title, live = false, description, actions, children }: {
  title: string
  /** Poll the seller status every few seconds (the overview); other pages refresh it slowly. */
  live?: boolean
  description?: (seller: AvailableSeller) => ReactNode
  actions?: ReactNode
  children: (seller: AvailableSeller) => ReactNode
}) {
  const status = useSellerStatus(true, live)
  if (status.isLoading) return <div className="gc-page"><PageHeader title={title} /><LoadingRows rows={6} /></div>
  if (status.error && !status.data) return <div className="gc-page"><PageHeader title={title} /><ErrorAlert error={status.error} onRetry={() => void status.refetch()} /></div>
  if (!status.data?.available) {
    return (
      <div className="gc-page">
        <PageHeader title={title} />
        <EmptyState icon={<Icon.seller size={18} />} title="No seller on this host"
          body="Start one with antseed seller start. Set ANTSEED_SELLER_DATA_DIR when it uses a different data directory than the gateway." />
      </div>
    )
  }
  const seller = status.data
  return (
    <div className="gc-page">
      <PageHeader title={title} description={description?.(seller)} actions={actions} />
      {/* A monitoring page must not show a stale "Running" as current. */}
      {status.error && <RefreshFailed error={status.error} what="the seller status" />}
      {children(seller)}
    </div>
  )
}

/** A background refresh failed while earlier data is still on screen: say so, and keep the page (and any edits on it). */
export function RefreshFailed({ error, what }: { error: unknown; what?: string }) {
  return <p className="gc-seller-notice" role="status"><span className="gc-attention" aria-hidden="true" />Could not refresh{what ? ` ${what}` : ''}: {errorMessage(error)}. Showing the last loaded data.</p>
}

/** Where the market and trust numbers come from and how old they are, with a refresh. */
export function NetworkLine({ network, onRefresh }: { network: SellerNetworkMeta; onRefresh: () => Promise<unknown> }) {
  // A refresh that fails (dashboard unreachable, endpoint error) says so here rather than leaving the old data looking current.
  const refresh = useMutation({ mutationFn: onRefresh })
  const when = network.refreshedAt ? `refreshed ${formatRelative(network.refreshedAt)}` : 'not loaded yet'
  return (
    <p className="gc-seller-network gc-fineprint" role="status">
      {network.refreshing && <span className="gc-attention" aria-hidden="true" />}
      <span>
        {network.refreshing && !network.refreshedAt ? 'Looking at the network. This can take a minute the first time.'
          : `${network.peers} seller${network.peers === 1 ? '' : 's'} on the network${network.source ? `, from ${network.source}` : ''}, ${when}${network.refreshing ? ', refreshing…' : '.'}`}
        {network.error && ` The last refresh failed: ${network.error}`}
        {refresh.error ? ` Could not refresh: ${errorMessage(refresh.error)}` : null}
      </span>
      <Button size="sm" variant="link" disabled={network.refreshing || refresh.isPending} onClick={() => refresh.mutate()}>Refresh</Button>
    </p>
  )
}
