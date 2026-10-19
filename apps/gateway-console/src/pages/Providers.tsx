import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DataTable, TextField } from '@antseed/ui'
import { api } from '../api'
import type { Peer, RoutePreview } from '../api/types'
import { copyModelIdItem, CopyIdButton, useCopy } from '../components/copy-actions'
import { Icon } from '../components/icons'
import { PeerActionDialog } from '../components/PeerActionDialog'
import { TeeBadge } from '../components/TeeBadge'
import { VerificationLinks } from '../components/VerificationLinks'
import { SplitView, type SidePanelContent } from '../components/SidePanel'
import { Badge, EmptyState, LoadingRows, Mono, PageHeader, PageLink, Panel, QueryView, SelectField, Switch } from '../components/ui'
import { formatLatency, formatNumber, formatPriceRange, formatSpeed, shortId } from '../lib/format'
import { canOpen, panelPath, panelSelection } from '../lib/nav'
import { useConsole } from '../app/context'
import { SellerListsButton } from '../components/PeerLists'
import { samePeerId } from '../lib/peer-id'
import { filterPeers, inputPrice, isFreePeer, outputPrice, priceRange, type PeerFilter } from '../lib/peers'
import { hasReputationData } from '../lib/policy-match'
import { modelsFromPeers, qk, usePeers } from '../lib/queries'
import { neverReason, rankCandidates } from '../lib/selection'
import { navigate, useLocation } from '../lib/router'
import { ProviderPanelBody, providerName } from './ProviderDetail'

type PeerActionKind = 'allow' | 'block' | 'prefer'

/** Where routing puts a seller for one model: its place in range, or why it is never selected. */
interface RoutingPlace { order: number; rank: number | null; reason: string | null }

function routingPlaces(preview: RoutePreview, peers: readonly Peer[]): Map<string, RoutingPlace> {
  const latency = new Map(peers.map((peer) => [peer.peerId.toLowerCase(), peer.firstTokenMsP50]))
  const { inRange, never } = rankCandidates(preview, (peerId) => latency.get(peerId.toLowerCase()) ?? null)
  const places = new Map<string, RoutingPlace>()
  if (preview.modelAllowed) inRange.forEach((candidate, index) => places.set(candidate.peerId.toLowerCase(), { order: index, rank: candidate.rank, reason: null }))
  const out = preview.modelAllowed ? never : [...inRange, ...never]
  out.forEach((candidate, index) => places.set(candidate.peerId.toLowerCase(), { order: 10_000 + index, rank: null, reason: neverReason(candidate, preview.modelAllowed) }))
  return places
}

function RoutingCell({ place }: { place: RoutingPlace | undefined }) {
  if (!place) return <span className="gc-muted">—</span>
  if (place.reason === null) return <span className="gc-strong">#{place.rank} in range</span>
  return (
    <div className="gc-cell-lines">
      <div>Filtered out</div>
      <div className="gc-muted gc-ellipsis" title={place.reason}>{place.reason}</div>
    </div>
  )
}

function score(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}

function ProviderBadges({ peer, model }: { peer: Peer; model: string }) {
  const coolingDown = (peer.health.coolingDownUntil ?? 0) > Date.now()
  return (
    <div className="gc-badges">
      <TeeBadge tee={peer.tee} scope={peer.teeScope} />
      {isFreePeer(peer, model) && <Badge tone="success">Free</Badge>}
      {peer.washFlagged && <Badge tone="danger">Flagged</Badge>}
      {coolingDown && <Badge tone="warning">Cooling down</Badge>}
    </div>
  )
}

/**
 * The providers (sellers) this gateway can route to (`/console/providers`).
 * Opening one (`providers/<peerId>`) shows it in the side panel: its models
 * with copyable ids, an API call, and Allow / Prefer / Block.
 */
export default function Providers() {
  const { viewer, workspace } = useConsole()
  const location = useLocation()
  const selectedId = panelSelection(location.rest)
  const peers = usePeers()
  const selected = useMemo(() => (selectedId ? peers.data?.find((peer) => samePeerId(peer.peerId, selectedId)) ?? null : null), [peers.data, selectedId])
  const [filter, setFilter] = useState<PeerFilter>({ search: '', model: '', tee: false, linked: false, free: false })
  const [action, setAction] = useState<{ peer: Peer; kind: PeerActionKind } | null>(null)
  const models = useMemo(() => modelsFromPeers(peers.data), [peers.data])
  const showReputation = hasReputationData(peers.data)
  const copy = useCopy()
  const preview = useQuery({
    queryKey: qk.routePreview({ model: filter.model, workspace: workspace.id }),
    queryFn: () => api.network.routePreview({ model: filter.model, workspace: workspace.id }),
    enabled: filter.model !== '',
    staleTime: 30_000,
  })
  const places = useMemo(() => (filter.model && preview.data ? routingPlaces(preview.data, peers.data ?? []) : null), [filter.model, preview.data, peers.data])
  const set = <K extends keyof PeerFilter>(key: K, value: PeerFilter[K]) => setFilter((current) => ({ ...current, [key]: value }))

  const panel: SidePanelContent | null = selectedId === null ? null : {
    eyebrow: 'Provider',
    title: selected ? providerName(selected) : shortId(selectedId, 8, 6),
    body: peers.isLoading ? <LoadingRows rows={6} />
      : selected ? <ProviderPanelBody key={selected.peerId} peer={selected} peers={peers.data} showReputation={showReputation} />
      : <EmptyState icon={<Icon.providers size={18} />} title="Provider not found" body={`This gateway does not see ${shortId(selectedId, 8, 6)} right now.`} />,
  }

  const list = (
    <div className="gc-page">
      <Panel flush>
        <QueryView query={peers} rows={8}>
          {(all) => (
            <DataTable<Peer> key={places ? `routing:${filter.model}` : 'all'} label="Providers" rows={filterPeers(all, filter)} rowKey={(peer) => peer.peerId}
              selectedKey={selected?.peerId ?? null}
              onRowClick={(peer) => navigate(panelPath('providers', peer.peerId))}
              rowLabel={(peer) => providerName(peer)}
              actions={(peer) => [
                filter.model !== '' && copyModelIdItem(copy, peer.peerId, filter.model),
                { label: 'Allow…', onSelect: () => setAction({ peer, kind: 'allow' }) },
                { label: 'Prefer…', onSelect: () => setAction({ peer, kind: 'prefer' }) },
                { label: 'Block…', tone: 'danger' as const, onSelect: () => setAction({ peer, kind: 'block' }) },
              ]}
              initialSort={places ? { key: 'routing', direction: 'asc' } : { key: 'trust', direction: 'desc' }}
              empty={<EmptyState icon={<Icon.providers size={18} />} title={all.length ? 'No providers match these filters' : 'No providers found yet'} body={all.length ? undefined : 'The buyer is still discovering the network. Check back in a minute.'} />}
              columns={[
                { key: 'name', header: 'Provider', sortValue: (peer) => peer.displayName ?? peer.peerId, render: (peer) => (
                  <div className="gc-cell-lines">
                    <div className="gc-strong gc-ellipsis" title={peer.displayName ?? peer.peerId}>{providerName(peer)}</div>
                    {peer.displayName && <div className="gc-muted gc-ellipsis"><Mono title={peer.peerId}>{shortId(peer.peerId, 6, 4)}</Mono></div>}
                    <ProviderBadges peer={peer} model={filter.model} />
                  </div>
                ), after: (peer) => <CopyIdButton value={peer.peerId} label={`Copy peer id ${peer.peerId}`} /> },
                ...(places ? [{ key: 'routing', header: 'Routing', sortValue: (peer: Peer) => places.get(peer.peerId.toLowerCase())?.order ?? 20_000,
                  render: (peer: Peer) => <RoutingCell place={places.get(peer.peerId.toLowerCase())} /> }] : []),
                { key: 'identity', header: 'Domain / GitHub', secondary: true, render: (peer) => peer.verificationLinks?.length ? <VerificationLinks links={peer.verificationLinks} /> : <span className="gc-muted">—</span> },
                { key: 'models', header: 'Models', secondary: true, optional: true, render: (peer) => <span className="gc-muted">{peer.services.length}</span> },
                { key: 'input', header: 'Input $/M', align: 'right', sortValue: (peer) => inputPrice(peer, filter.model), render: (peer) => formatPriceRange(priceRange(peer, 'inputUsdPerMillion', filter.model)) },
                { key: 'output', header: 'Output $/M', align: 'right', secondary: true, sortValue: (peer) => outputPrice(peer, filter.model), render: (peer) => formatPriceRange(priceRange(peer, 'outputUsdPerMillion', filter.model)) },
                { key: 'trust', header: 'Trust', align: 'right', sortValue: (peer) => peer.trustScore, render: (peer) => score(peer.trustScore) },
                ...(showReputation ? [{ key: 'reputation', header: 'Reputation', align: 'right' as const, secondary: true, optional: true, sortValue: (peer: Peer) => peer.reputationScore, render: (peer: Peer) => score(peer.reputationScore) }] : []),
                { key: 'firstToken', header: 'First token', align: 'right', secondary: true, optional: true, sortValue: (peer) => peer.firstTokenMsP50, render: (peer) => formatLatency(peer.firstTokenMsP50) },
                { key: 'speed', header: 'Speed', align: 'right', secondary: true, optional: true, sortValue: (peer) => peer.tokensPerSecondP50, render: (peer) => formatSpeed(peer.tokensPerSecondP50) },
                { key: 'usage', header: 'Your 24h', align: 'right', secondary: true, sortValue: (peer) => peer.requests24h, render: (peer) => formatNumber(peer.requests24h) },
              ]} />
          )}
        </QueryView>
      </Panel>
      {/* Seller lists live on Routing, which only workspace admins open; everyone else sees them here in a dialog. */}
      <p className="gc-fineprint">
        Seller lists group sellers that routing rules allow or block together:{' '}
        {canOpen('routing', viewer) ? <PageLink to="routing">Routing → Seller lists</PageLink> : <SellerListsButton peers={peers.data} label="See seller lists" />}.
      </p>
    </div>
  )

  return (
    <div className="gc-page">
      <PageHeader title="Providers" description="Providers on the network this gateway can route to. Open one to copy its models and an API call, or allow, block or prefer it for any scope." />
      <div className="gc-toolbar">
        <TextField size="sm" type="search" aria-label="Search providers" placeholder="Search name, peer id or model" value={filter.search} onChange={(event) => set('search', event.target.value)} />
        <SelectField size="sm" aria-label="Filter by model" value={filter.model} onChange={(value) => set('model', value)}
          options={[{ value: '', label: 'All models' }, ...models.map((model) => ({ value: model, label: model }))]} />
        <Switch checked={filter.linked} onChange={(value) => set('linked', value)} label="Domain or GitHub" />
        <Switch checked={filter.tee} onChange={(value) => set('tee', value)} label="TEE" />
        <Switch checked={filter.free} onChange={(value) => set('free', value)} label="Free" />
      </div>
      <p className="gc-fineprint">
        {filter.model
          ? <>Ordered the way your routing policy tries sellers for <code>{filter.model}</code>: the ones in range first, then the ones it filters out, with the reason.</>
          : 'Pick a model to order providers the way your routing policy tries them and see which ones it filters out, and why.'}
      </p>
      <SplitView list={list} panel={panel} onClose={() => navigate('providers')} closeLabel="Close provider" />
      {action && <PeerActionDialog peer={action.peer} action={action.kind} peers={peers.data} onClose={() => setAction(null)} />}
    </div>
  )
}
