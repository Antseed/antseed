import { lazy, Suspense, useMemo, useState } from 'react'
import { DataTable, LoadingRows, TextField } from '@antseed/ui'
import type { Peer } from '../api/types'
import { copyModelIdItem, useCopy } from '../components/copy-actions'
import { PeerActionDialog } from '../components/PeerActionDialog'
import { PeerListsPanel } from '../components/PeerLists'
import { Badge, EmptyState, PageHeader, Panel, QueryView, SelectField, Switch } from '../components/ui'
import { formatLatency, formatNumber, formatPricePerMillion, shortId } from '../lib/format'
import { filterPeers, inputPrice, isFreePeer, outputPrice, type PeerFilter } from '../lib/peers'
import { hasReputationData } from '../lib/policy-match'
import { modelsFromPeers, usePeers } from '../lib/queries'
import { Icon } from '../components/icons'
import { navigate, useLocation } from '../lib/router'

type PeerActionKind = 'allow' | 'block' | 'prefer'

function score(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}

function SellerBadges({ peer, model }: { peer: Peer; model: string }) {
  const coolingDown = (peer.health.coolingDownUntil ?? 0) > Date.now()
  return (
    <div className="gc-badges">
      {peer.verified && <Badge tone="success">Verified</Badge>}
      {peer.tee && <Badge tone="info">TEE</Badge>}
      {isFreePeer(peer, model) && <Badge tone="success">Free</Badge>}
      {peer.washFlagged && <Badge tone="danger">Flagged</Badge>}
      {coolingDown && <Badge tone="warning">Cooling down</Badge>}
    </div>
  )
}

const Seller = lazy(() => import('./Seller'))

export default function Network() {
  const location = useLocation()
  const sellerId = location.rest[0] ? decodeURIComponent(location.rest[0]) : null
  if (sellerId) return <Suspense fallback={<LoadingRows rows={6} />}><Seller peerId={sellerId} /></Suspense>
  return <NetworkList />
}

function NetworkList() {
  const peers = usePeers()
  const [filter, setFilter] = useState<PeerFilter>({ search: '', model: '', tee: false, verified: false, free: false })
  const [action, setAction] = useState<{ peer: Peer; kind: PeerActionKind } | null>(null)
  const models = useMemo(() => modelsFromPeers(peers.data), [peers.data])
  const showReputation = hasReputationData(peers.data)
  const copy = useCopy()
  const set = <K extends keyof PeerFilter>(key: K, value: PeerFilter[K]) => setFilter((current) => ({ ...current, [key]: value }))

  return (
    <div className="gc-page">
      <PageHeader title="Network" description="Sellers this gateway can route to. Allow, block or prefer them for any scope." />
      <div className="gc-toolbar">
        <TextField size="sm" type="search" aria-label="Search sellers" placeholder="Search name, peer id or model" value={filter.search} onChange={(event) => set('search', event.target.value)} />
        <SelectField size="sm" aria-label="Filter by model" value={filter.model} onChange={(value) => set('model', value)}
          options={[{ value: '', label: 'All models' }, ...models.map((model) => ({ value: model, label: model }))]} />
        <Switch checked={filter.verified} onChange={(value) => set('verified', value)} label="Verified" />
        <Switch checked={filter.tee} onChange={(value) => set('tee', value)} label="TEE" />
        <Switch checked={filter.free} onChange={(value) => set('free', value)} label="Free" />
      </div>
      <Panel flush>
        <QueryView query={peers} rows={8}>
          {(list) => (
            <DataTable<Peer> label="Sellers" rows={filterPeers(list, filter)} rowKey={(peer) => peer.peerId} onRowClick={(peer) => navigate(`network/${peer.peerId}`)}
              rowLabel={(peer) => peer.displayName ?? shortId(peer.peerId, 8, 4)}
              actions={(peer) => [
                filter.model !== '' && copyModelIdItem(copy, peer.peerId, filter.model),
                { label: 'Allow…', onSelect: () => setAction({ peer, kind: 'allow' }) },
                { label: 'Prefer…', onSelect: () => setAction({ peer, kind: 'prefer' }) },
                { label: 'Block…', tone: 'danger' as const, onSelect: () => setAction({ peer, kind: 'block' }) },
              ]}
              initialSort={{ key: 'trust', direction: 'desc' }}
              empty={<EmptyState icon={<Icon.network size={18} />} title={list.length ? 'No sellers match these filters' : 'No sellers found yet'} body={list.length ? undefined : 'The buyer is still discovering the network. Check back in a minute.'} />}
              columns={[
                { key: 'name', header: 'Seller', sortValue: (peer) => peer.displayName ?? peer.peerId, render: (peer) => (
                  <div>
                    <div className="gc-strong gc-ellipsis" title={peer.displayName ?? peer.peerId}>{peer.displayName ?? shortId(peer.peerId, 8, 4)}</div>
                    <SellerBadges peer={peer} model={filter.model} />
                  </div>
                ) },
                { key: 'models', header: 'Models', secondary: true, optional: true, render: (peer) => <span className="gc-muted">{peer.services.length}</span> },
                { key: 'input', header: 'Input $/M', align: 'right', sortValue: (peer) => inputPrice(peer, filter.model), render: (peer) => formatPricePerMillion(inputPrice(peer, filter.model)) },
                { key: 'output', header: 'Output $/M', align: 'right', secondary: true, sortValue: (peer) => outputPrice(peer, filter.model), render: (peer) => formatPricePerMillion(outputPrice(peer, filter.model)) },
                { key: 'trust', header: 'Trust', align: 'right', sortValue: (peer) => peer.trustScore, render: (peer) => score(peer.trustScore) },
                ...(showReputation ? [{ key: 'reputation', header: 'Reputation', align: 'right' as const, secondary: true, optional: true, sortValue: (peer: Peer) => peer.reputationScore, render: (peer: Peer) => score(peer.reputationScore) }] : []),
                { key: 'latency', header: 'Latency', align: 'right', secondary: true, optional: true, sortValue: (peer) => peer.latencyMsP50, render: (peer) => formatLatency(peer.latencyMsP50) },
                { key: 'usage', header: 'Your 24h', align: 'right', secondary: true, sortValue: (peer) => peer.requests24h, render: (peer) => formatNumber(peer.requests24h) },
              ]} />
          )}
        </QueryView>
      </Panel>

      <PeerListsPanel peers={peers.data} />

      {action && <PeerActionDialog peer={action.peer} action={action.kind} peers={peers.data} onClose={() => setAction(null)} />}
    </div>
  )
}
