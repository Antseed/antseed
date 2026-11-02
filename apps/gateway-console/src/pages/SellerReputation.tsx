import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import type { SellerReputation as Reputation, SellerStanding } from '../api/types'
import { NetworkLine, RefreshFailed, SellerPage } from '../components/SellerPage'
import { TrustTip } from '../components/TrustInfo'
import { DetailList, EmptyState, ErrorAlert, LoadingRows, Panel, StatTile } from '../components/ui'
import { formatNumber, formatRelative, formatUsd } from '../lib/format'
import { qk, useSellerReputation } from '../lib/queries'
import '../styles/seller.scss'

const points = (value: number) => (Math.round(value * 10) / 10).toLocaleString('en-US')
const share = (bps: number) => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`

/** The trust score buyers compute for this seller, part by part, with what would raise each. */
export default function SellerReputation() {
  const reputation = useSellerReputation()
  const queryClient = useQueryClient()
  const refresh = async () => {
    queryClient.setQueryData(qk.sellerReputation, await api.seller.reputation(true))
  }
  return (
    <SellerPage title="Reputation" description={() => 'The trust score buyers compute for you (0-100), what it is made of, and your on-chain standing.'}>
      {() => {
        if (reputation.isLoading) return <LoadingRows rows={6} />
        if (reputation.error && !reputation.data) return <ErrorAlert error={reputation.error} onRetry={() => void reputation.refetch()} />
        const data = reputation.data!
        return (
          <>
            {reputation.error && <RefreshFailed error={reputation.error} />}
            <NetworkLine network={data.network} onRefresh={refresh} />
            <TrustTiles data={data} />
            <div className="gc-grid gc-grid--2">
              <Panel title="How to raise it" description="Biggest gain first.">
                {data.steps.length === 0 ? <EmptyState title="Nothing left to gain" body="Every part of the score is at its maximum." />
                  : <ol className="gc-seller-steps">{data.steps.map((step) => <li key={step.part}>{step.text}</li>)}</ol>}
              </Panel>
              <Panel title="On-chain standing" description={data.standingRefreshedAt ? `Read from the chain ${formatRelative(data.standingRefreshedAt)}.` : 'Read from the chain in the background.'}>
                <Standing standing={data.standing} error={data.standingError} />
              </Panel>
            </div>
          </>
        )
      }}
    </SellerPage>
  )
}

function TrustTiles({ data }: { data: Reputation }) {
  const trust = data.trust
  if (!trust) {
    return (
      <Panel title="Trust score">
        <EmptyState title={data.network.refreshedAt ? 'No score yet' : 'Loading'}
          body={data.network.refreshedAt ? 'Buyers have not scored this seller: it was not found on the network, or nothing about it is on-chain yet.' : 'The score appears once the network snapshot is in.'} />
      </Panel>
    )
  }
  const part = (label: string, value: { score: number; max: number } | null, sub: string) => (
    <StatTile label={label} value={value ? `${points(value.score)} / ${value.max}` : '—'} sub={sub} meter={value ? value.score / value.max : null} tone="default" />
  )
  return (
    <>
      <div className="gc-grid gc-grid--4">
        <StatTile label={<span className="gc-inline">Trust score <TrustTip /></span>} value={trust.washFlagged ? '0' : points(trust.score)} meter={trust.score / 100} tone="default"
          sub={data.rank ? `#${data.rank.position} of ${data.rank.of} scored sellers` : 'of 100'} />
        {part('Service history', trust.history, trust.history ? `${formatNumber(trust.history.channelCount)} settled channels, ${formatUsd(trust.history.volumeUsdc)}` : 'No settled channels read')}
        {part('Recognized usage', trust.usage, trust.usage ? `${share(trust.usage.shareBps)} of epoch ${trust.usage.epoch} usage points` : 'No usage points')}
        {part('Staking power', trust.power, trust.power ? `${share(trust.power.shareBps)} of all pool power` : 'No staking pool')}
      </div>
      <div className="gc-grid gc-grid--4">
        {part('Verified identity', trust.identity, trust.identity ? `${trust.identity.kind === 'domain' ? 'Domain' : 'GitHub'}: ${trust.identity.claim}` : 'No verified domain or GitHub')}
        {part('Free model bonus', trust.freeModels, trust.freeModels ? `${trust.freeModels.service} is free` : 'No free model')}
        <StatTile label="Wash trading" value={trust.washFlagged === null ? 'Unknown' : trust.washFlagged ? 'Flagged' : 'Clear'} sub={trust.washFlagged ? 'The score is 0 while flagged' : 'From the on-chain registry'} />
      </div>
    </>
  )
}

function Standing({ standing, error }: { standing: SellerStanding | null; error: string | null }) {
  if (!standing) return error ? <p className="gc-seller-notice"><span className="gc-attention" aria-hidden="true" />{error}</p> : <LoadingRows rows={4} height={22} />
  const pool = standing.pool
  return (
    <DetailList items={[
      ['Agent', standing.agentId ? `#${standing.agentId}${standing.registryBound ? '' : ' (not bound to this seller)'}` : 'Not registered'],
      ['Eligible for rewards', standing.eligible ? 'Yes' : 'No'],
      ['Pool stake', `${standing.poolActiveStake} ANTS${Number(standing.minPoolStake) > 0 ? ` of ${standing.minPoolStake} minimum` : ''}`],
      ['Pool power', pool ? share(pool.powerShareBps) : '—'],
      ['Stakers', pool?.stakers ?? '—'],
      ['Pending seller rewards', standing.pendingRewards ? `${standing.pendingRewards} ANTS` : '—'],
      ['Settled volume', pool?.lifetimeVolumeUsdc ? formatUsd(Number(pool.lifetimeVolumeUsdc)) : '—'],
      ['Unique buyers', pool?.uniqueBuyers ?? '—'],
      ['Requests', pool?.requestCount ? formatNumber(Number(pool.requestCount)) : '—'],
      ['Ghost rate', pool?.ghostRate === null || pool?.ghostRate === undefined ? '—' : `${pool.ghostRate.toFixed(1)}%`],
    ]} />
  )
}

