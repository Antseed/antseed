import { useState, type ReactNode } from 'react'
import { ActionMenu, Button, Segmented } from '@antseed/ui'
import { api } from '../api'
import type { RoutePreview } from '../api/types'
import { useConsole } from '../app/context'
import { useConsoleMutation } from '../lib/mutations'
import { isOrgAdmin, panelPath } from '../lib/nav'
import { qk, usePeers } from '../lib/queries'
import { samePeerId } from '../lib/peer-id'
import { PeerActionDialog } from './PeerActionDialog'
import { ServiceHealthInfo } from './ServiceHealthInfo'
import { healthWarning, neverReason, orderingSummary, rankCandidates, selectionHeadline } from '../lib/selection'
import { shortId } from '../lib/format'
import { PanelRow, PanelSection } from './SidePanel'
import { Badge, LoadingRows, PageLink } from './ui'

type Candidate = RoutePreview['candidates'][number]
type PeerActionKind = 'allow' | 'prefer' | 'block'


function candidateName(candidate: Candidate): string {
  return candidate.displayName ?? shortId(candidate.peerId, 8, 4)
}

/** What a caller adds to a seller's row: its offer's facts, badges and actions. */
export interface SellerRowExtras {
  meta?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  selected?: boolean
}

/**
 * A model's sellers the way automatic routing sees them: the ones in range, in
 * the order they are tried, with each one's record (success rate, speed,
 * expected cost, its share of the traffic), then every seller it never selects
 * with the reason, ordered by the same sort. `pin` offers a Pin button per
 * seller (the chat's seller choice); `row` adds a caller's own facts and
 * actions (the Models page's offers).
 */
export function SellerSelection({ preview, loading, pin, title, explainSkipped, row, latencyOf }: {
  preview: RoutePreview | undefined
  loading: boolean
  pin?: { peerId: string | null; onChange: (peerId: string | null) => void }
  title?: ReactNode
  /** Which rule keeps a skipped seller out, shown under its reasons. */
  explainSkipped?: (candidate: Candidate) => ReactNode
  row?: (peerId: string) => SellerRowExtras
  /** First-token medians, for ordering the skipped sellers under a speed sort. */
  latencyOf?: (peerId: string) => number | null
}) {
  const { viewer } = useConsole()
  const admin = isOrgAdmin(viewer)
  const reset = useConsoleMutation({
    mutationFn: (peerId: string) => api.network.resetSellerHistory(peerId),
    invalidate: [qk.group('routing'), ['chat-route-preview']],
    toast: 'History cleared: the seller starts fresh.',
  })
  const peers = usePeers()
  const [action, setAction] = useState<{ peerId: string; kind: PeerActionKind } | null>(null)
  const [view, setView] = useState<'range' | 'all' | null>(null)
  const heading = (count?: number) => title ?? (count === undefined ? 'Providers' : `Providers (${count})`)
  if (loading) return <PanelSection title={heading()}><LoadingRows rows={3} /></PanelSection>
  if (!preview) return null
  const { inRange, never } = rankCandidates(preview, latencyOf)
  const eligible = preview.modelAllowed ? inRange : []
  const skipped = preview.modelAllowed ? never : [...inRange, ...never]
  const first = eligible[0]?.selection ?? null
  const pinnedPeer = pin?.peerId ?? null
  /** Allow / Prefer / Block for a seller, at a level the viewer picks. */
  const peerMenu = (candidate: Candidate, allowShown: boolean) => (
    <ActionMenu label={`More for ${candidateName(candidate)}`} items={[
      !allowShown && { label: 'Allow…', onSelect: () => setAction({ peerId: candidate.peerId, kind: 'allow' }) },
      { label: 'Prefer for this model…', onSelect: () => setAction({ peerId: candidate.peerId, kind: 'prefer' }) },
      { label: 'Block…', tone: 'danger' as const, onSelect: () => setAction({ peerId: candidate.peerId, kind: 'block' }) },
    ]} />
  )
  const isPinned = (peerId: string) => pinnedPeer !== null && pinnedPeer === peerId.toLowerCase()

  // Sellers in range by default; "All" adds the ones the policy filters out, dimmed, with the reason.
  const shown = view ?? (eligible.length > 0 ? 'range' : 'all')
  const filteredNote = skipped.length > 0 && shown === 'range' && (
    <p className="gc-fineprint">
      Your routing settings filter out {skipped.length} more seller{skipped.length === 1 ? '' : 's'} for this model.{' '}
      <button type="button" className="gc-link-button" onClick={() => setView('all')}>Show {skipped.length === 1 ? 'it' : 'them'}</button>
    </p>
  )
  return (
    <PanelSection title={heading(skipped.length > 0 && eligible.length > 0 ? undefined : preview.candidates.length)}
      actions={skipped.length > 0 && eligible.length > 0 && (
        <Segmented label="Which sellers to show" value={shown} onChange={setView}
          options={[{ value: 'range', label: `In range (${eligible.length})` }, { value: 'all', label: `All (${eligible.length + skipped.length})` }]} />
      )}>
      {!preview.modelAllowed
        ? <p className="gc-fineprint">Your routing policy does not allow this model: requests for it are refused.</p>
        : eligible.length === 0
          ? <p className="gc-fineprint">No seller passes your routing settings for this model right now.</p>
          : (
            <p className="gc-fineprint">
              {pinnedPeer ? 'Pinned: every request goes to the pinned seller. Without the pin, automatic routing works like this. ' : ''}
              {first ? orderingSummary(first.ordering, first.poolSize) : 'Sellers in the order automatic routing tries them; the next one takes over when one fails.'}
            </p>
          )}
      {(eligible.length > 0 || (shown === 'all' && skipped.length > 0)) && (
        <ol className="gc-panel-rows" aria-label={shown === 'all' ? 'All sellers: in routing order, then the ones filtered out' : 'Sellers in range, in routing order'}>
          {eligible.map((candidate) => {
            const selection = candidate.selection
            const warning = selection ? healthWarning(selection) : null
            const extras = row?.(candidate.peerId) ?? {}
            const on = extras.selected ?? isPinned(candidate.peerId)
            const exceptions = !!selection && (selection.record === 'none' || selection.channel !== 'open' && selection.channel !== null || selection.routeChainPosition !== null
              || (selection.maxConcurrency !== null && selection.inFlight >= selection.maxConcurrency) || selection.failing || selection.coolingDown)
            return (
              <PanelRow key={candidate.peerId} selected={on}
                title={<>
                  <span className="gc-muted">#{candidate.rank}</span>{' '}
                  <PageLink to={panelPath('providers', candidate.peerId)}>{candidateName(candidate)}</PageLink>
                </>}
                meta={<>
                  <span>{selection ? selectionHeadline(selection) : candidate.reasons.join(' · ')}</span>
                  {extras.meta}
                  <ServiceHealthInfo health={candidate.health} />
                </>}
                badges={(exceptions || warning || extras.badges) && (
                  <div className="gc-stack gc-stack--tight">
                    <div className="gc-badges">
                      {selection?.routeChainPosition != null && <Badge>Route #{selection.routeChainPosition}</Badge>}
                      {selection?.channel === 'free' && <Badge tone="success">Free</Badge>}
                      {selection?.channel === 'new' && <Badge title="The first request reserves a payment channel (about 5 s)">New channel</Badge>}
                      {selection?.record === 'none' && <Badge title="No requests yet: assumed to succeed 80% of the time">New</Badge>}
                      {selection && selection.maxConcurrency !== null && selection.inFlight >= selection.maxConcurrency && <Badge tone="warning">At capacity</Badge>}
                      {selection?.coolingDown ? <Badge tone="warning">Cooling down</Badge> : selection?.failing ? <Badge tone="warning">Failing</Badge> : null}
                      {extras.badges}
                    </div>
                    {warning && <span className="gc-fineprint">{warning}</span>}
                  </div>
                )}
                actions={<>
                  {admin && selection && (selection.failing || selection.coolingDown) && (
                    <Button size="sm" variant="ghost" disabled={reset.isPending} title="Forget what this gateway has seen of the seller, so routing gives it a fresh start"
                      onClick={() => reset.mutate(candidate.peerId)}>Reset history</Button>
                  )}
                  {extras.actions ?? (pin && (
                    <Button size="sm" variant={on ? 'outline' : 'ghost'} aria-pressed={on}
                      onClick={() => pin.onChange(on ? null : candidate.peerId.toLowerCase())}>{on ? 'Pinned' : 'Pin'}</Button>
                  ))}
                  {peerMenu(candidate, false)}
                </>} />
            )
          })}
          {shown === 'all' && <>
          {skipped.map((candidate) => {
            const extras = row?.(candidate.peerId) ?? {}
            const on = extras.selected ?? isPinned(candidate.peerId)
            const rule = explainSkipped?.(candidate)
            return (
              <PanelRow key={candidate.peerId} selected={on} muted
                title={<PageLink to={panelPath('providers', candidate.peerId)}>{candidateName(candidate)}</PageLink>}
                meta={<>
                  <span className="gc-never">Filtered out: {neverReason(candidate, preview.modelAllowed)}</span>
                  {extras.meta}
                  <ServiceHealthInfo health={candidate.health} />
                </>}
                badges={(rule || extras.badges) && <div className="gc-stack gc-stack--tight">{rule}{extras.badges && <div className="gc-badges">{extras.badges}</div>}</div>}
                actions={<>
                  <Button size="sm" variant="ghost" title="Add this seller to an allow list, at the level you choose"
                    onClick={() => setAction({ peerId: candidate.peerId, kind: 'allow' })}>Allow…</Button>
                  {extras.actions ?? (pin && (
                    <Button size="sm" variant={on ? 'outline' : 'ghost'} aria-pressed={on}
                      onClick={() => pin.onChange(on ? null : candidate.peerId.toLowerCase())}>{on ? 'Pinned' : 'Pin'}</Button>
                  ))}
                  {peerMenu(candidate, true)}
                </>} />
            )
          })}
          </>}
        </ol>
      )}
      {filteredNote}
      {action && (
        <PeerActionDialog action={action.kind} model={preview.model} peers={peers.data} onClose={() => setAction(null)}
          peer={peers.data?.find((peer) => samePeerId(peer.peerId, action.peerId)) ?? null} />
      )}
    </PanelSection>
  )
}
