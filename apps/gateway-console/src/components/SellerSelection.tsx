import type { ReactNode } from 'react'
import { Button, Disclosure } from '@antseed/ui'
import { api } from '../api'
import type { RoutePreview } from '../api/types'
import { useConsole } from '../app/context'
import { useConsoleMutation } from '../lib/mutations'
import { isOrgAdmin, panelPath } from '../lib/nav'
import { qk } from '../lib/queries'
import { healthWarning, orderingSummary, selectionFacts } from '../lib/selection'
import { shortId } from '../lib/format'
import { PanelRow, PanelSection } from './SidePanel'
import { Badge, LoadingRows, PageLink } from './ui'

type Candidate = RoutePreview['candidates'][number]

function candidateName(candidate: Candidate): string {
  return candidate.displayName ?? shortId(candidate.peerId, 8, 4)
}

/**
 * Which sellers automatic routing sends a model's requests to, in order, and
 * why: the ordering, each seller's record (success rate, speed, expected
 * cost, its share of the traffic) and the sellers it leaves out. `pin`
 * offers a Pin button per seller (the chat's seller choice).
 */
export function SellerSelection({ preview, loading, pin, title = 'Seller selection', explainSkipped, skippedOpen = false }: {
  preview: RoutePreview | undefined
  loading: boolean
  pin?: { peerId: string | null; onChange: (peerId: string | null) => void }
  title?: ReactNode
  /** Which rule keeps a skipped seller out, shown under its reasons. */
  explainSkipped?: (candidate: Candidate) => ReactNode
  skippedOpen?: boolean
}) {
  const { viewer } = useConsole()
  const admin = isOrgAdmin(viewer)
  const reset = useConsoleMutation({
    mutationFn: (peerId: string) => api.network.resetSellerHistory(peerId),
    invalidate: [qk.group('routing'), ['chat-route-preview']],
    toast: 'History cleared: the seller starts fresh.',
  })
  if (loading) return <PanelSection title={title}><LoadingRows rows={3} /></PanelSection>
  if (!preview) return null
  const eligible = preview.candidates.filter((candidate) => candidate.eligible).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
  const skipped = preview.candidates.filter((candidate) => !candidate.eligible)
  const first = eligible[0]?.selection ?? null
  const pinnedPeer = pin?.peerId ?? null

  return (
    <PanelSection title={title}>
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
      {eligible.length > 0 && (
        <ol className="gc-panel-rows" aria-label="Sellers in routing order">
          {eligible.map((candidate) => {
            const selection = candidate.selection
            const warning = selection ? healthWarning(selection) : null
            const on = pinnedPeer !== null && pinnedPeer === candidate.peerId.toLowerCase()
            return (
              <PanelRow key={candidate.peerId} selected={on}
                title={<>
                  <span className="gc-muted">#{candidate.rank}</span>{' '}
                  <PageLink to={panelPath('providers', candidate.peerId)}>{candidateName(candidate)}</PageLink>
                </>}
                meta={selection
                  ? selectionFacts(selection).map((fact) => <span key={fact}>{fact}</span>)
                  : candidate.reasons.map((reason) => <span key={reason}>{reason}</span>)}
                badges={(selection?.sharesTraffic || warning || selection?.stale || selection?.channel === 'free' || selection?.routeChainPosition) && (
                  <div className="gc-stack gc-stack--tight">
                    <div className="gc-badges">
                      {selection?.routeChainPosition != null && <Badge>Route #{selection.routeChainPosition}</Badge>}
                      {selection?.sharesTraffic && <Badge>Shares traffic</Badge>}
                      {selection?.channel === 'free' && <Badge tone="success">Free</Badge>}
                      {selection?.coolingDown ? <Badge tone="warning">Cooling down</Badge> : selection?.failing ? <Badge tone="warning">Failing</Badge> : null}
                      {selection?.stale && !selection.failing && !selection.coolingDown && <Badge>{selection.record === 'none' ? 'New' : 'Not seen lately'}</Badge>}
                    </div>
                    {warning && <span className="gc-fineprint">{warning}</span>}
                  </div>
                )}
                actions={<>
                  {admin && selection && (selection.failing || selection.coolingDown) && (
                    <Button size="sm" variant="ghost" disabled={reset.isPending} title="Forget what this gateway has seen of the seller, so routing gives it a fresh start"
                      onClick={() => reset.mutate(candidate.peerId)}>Reset history</Button>
                  )}
                  {pin && (
                    <Button size="sm" variant={on ? 'outline' : 'ghost'} aria-pressed={on}
                      onClick={() => pin.onChange(on ? null : candidate.peerId.toLowerCase())}>{on ? 'Pinned' : 'Pin'}</Button>
                  )}
                </>} />
            )
          })}
        </ol>
      )}
      {skipped.length > 0 && (
        <Disclosure title="Not used" summary={`${skipped.length} seller${skipped.length === 1 ? '' : 's'}`} defaultOpen={skippedOpen}>
          <ul className="gc-panel-rows" aria-label="Sellers automatic routing skips">
            {skipped.map((candidate) => (
              <PanelRow key={candidate.peerId}
                title={<PageLink to={panelPath('providers', candidate.peerId)}>{candidateName(candidate)}</PageLink>}
                meta={<span>{candidate.reasons.join(' · ') || 'not eligible'}</span>}
                badges={explainSkipped?.(candidate)}
                actions={pin && (
                  <Button size="sm" variant="ghost" title="Pinning skips your routing settings' ranking, not the hard limits"
                    onClick={() => pin.onChange(candidate.peerId.toLowerCase())}>Pin</Button>
                )} />
            ))}
          </ul>
        </Disclosure>
      )}
    </PanelSection>
  )
}
