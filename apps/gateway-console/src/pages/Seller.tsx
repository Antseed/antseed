import { useState } from 'react'
import { BarChart, DataTable } from '@antseed/ui'
import type { SellerUsage } from '../api/types'
import { Badge, EmptyState, ErrorAlert, Figure, LoadingRows, PageLink, Panel, Segmented, StatTile } from '../components/ui'
import { formatDuration, formatNumber, formatRelative, formatUsd, shortId } from '../lib/format'
import { useSellerEvents, useSellerUsage } from '../lib/queries'
import { formatEth, formatUtcDay, lastResult, sellerNotices, usageTotals, type AvailableSeller } from '../lib/seller'
import { SellerPage } from '../components/SellerPage'
import { SellerEventList } from '../components/SellerEvents'
import '../styles/seller.scss'

const DAYS = 14
type ChartMetric = 'requests' | 'revenue'
const CHART_METRICS: Array<{ value: ChartMetric; label: string }> = [
  { value: 'requests', label: 'Requests' },
  { value: 'revenue', label: 'Revenue' },
]

/** The seller on this host: live status, model health, gas, earnings and recent events. */
export default function Seller() {
  return <SellerPage title="Seller" description={headerLine}>{(seller) => <Overview seller={seller} />}</SellerPage>
}

function Overview({ seller }: { seller: AvailableSeller }) {
  const usage = useSellerUsage(DAYS)
  const events = useSellerEvents()
  return (
    <>
      <Notices seller={seller} />
      <Tiles seller={seller} usage={usage.data} />
      <UsagePanel usage={usage} />
      <ModelsPanel seller={seller} />
      <div className="gc-grid gc-grid--2">
        <EventsPanel events={events} />
        <PaymentsPanel usage={usage.data} />
      </div>
    </>
  )
}

function headerLine(seller: AvailableSeller): string {
  const parts = [seller.running ? `Running for ${formatDuration(seller.startedAt ? Date.now() - seller.startedAt : null)}` : 'Not running']
  if (seller.peerId) parts.push(`peer ${shortId(seller.peerId)}`)
  if (seller.provider) parts.push(seller.provider)
  return parts.join(' · ')
}

function Notices({ seller }: { seller: AvailableSeller }) {
  const lines = sellerNotices(seller)
  if (lines.length === 0) return null
  return (
    <div className="gc-seller-notices" role="status">
      {lines.map((line) => <p key={line} className="gc-seller-notice"><span className="gc-attention" aria-hidden="true" />{line}</p>)}
    </div>
  )
}

function Tiles({ seller, usage }: { seller: AvailableSeller; usage?: SellerUsage }) {
  const totals = usage ? usageTotals(usage.days) : null
  const gas = seller.gas
  return (
    <div className="gc-grid gc-grid--4">
      <StatTile label="Requests today" value={totals ? formatNumber(totals.requestsToday) : '…'}
        sub={totals ? `${formatNumber(totals.requestsWeek)} in 7 days` : undefined} />
      <StatTile label="Revenue today" value={totals ? formatUsd(totals.revenueToday) : '…'}
        sub={totals ? `${formatUsd(totals.revenueWeek)} in 7 days` : undefined} />
      <StatTile label="Active channels" value={formatNumber(seller.activeChannels)}
        sub={`${seller.capacityUsedPercent}% of capacity`} meter={seller.capacityUsedPercent / 100} />
      <StatTile label="Gas" value={gas ? `${formatEth(gas.balanceEth)} ETH` : '—'}
        sub={gas ? (gas.depleted ? 'Below minimum, advertising paused' : `Minimum ${formatEth(gas.minBalanceEth)} ETH`) : 'No gas checks (payments off)'} />
    </div>
  )
}

function UsagePanel({ usage }: { usage: ReturnType<typeof useSellerUsage> }) {
  const [metric, setMetric] = useState<ChartMetric>('requests')
  const revenue = metric === 'revenue'
  return (
    <Panel title={`Last ${DAYS} days`} description="UTC days, from this seller's metering ledger."
      actions={<Segmented label="Chart metric" value={metric} onChange={setMetric} options={CHART_METRICS} />}>
      {usage.isLoading && <LoadingRows rows={1} height={200} />}
      {usage.error && <ErrorAlert error={usage.error} onRetry={() => void usage.refetch()} />}
      {usage.data && (
        <BarChart label={revenue ? 'Revenue per day' : 'Requests per day'} height={200}
          format={revenue ? (value) => formatUsd(value) : (value) => formatNumber(value)}
          points={usage.data.days.map((day) => ({
            label: formatUtcDay(day.day),
            value: revenue ? day.revenueUsd : day.requests,
            sub: revenue ? `${formatNumber(day.requests)} requests` : `${formatNumber(day.sessions)} sessions`,
          }))} />
      )}
    </Panel>
  )
}

function ModelsPanel({ seller }: { seller: AvailableSeller }) {
  type Row = AvailableSeller['models'][number]
  return (
    <Panel title="Models" description="Health checks probe every service; a service that keeps failing is withdrawn until it recovers." flush>
      <DataTable<Row> label="Model health" rows={seller.models} rowKey={(row) => `${row.provider}/${row.service}`}
        empty={<EmptyState title="No health data yet" body="Model health appears once the seller has run its first checks." />}
        columns={[
          { key: 'service', header: 'Service', render: (row) => <span className="gc-ellipsis" title={row.service}>{row.service}</span>, sortValue: (row) => row.service },
          { key: 'provider', header: 'Provider', secondary: true, render: (row) => row.provider, sortValue: (row) => row.provider },
          {
            key: 'status', header: 'Status', sortValue: (row) => (row.advertised ? 1 : 0),
            render: (row) => (row.advertised ? <Badge tone="neutral">Advertised</Badge> : <Badge tone="warning">Withdrawn</Badge>),
          },
          { key: 'failures', header: 'Failures', align: 'right', render: (row) => formatNumber(row.consecutiveFailures), sortValue: (row) => row.consecutiveFailures },
          { key: 'last', header: 'Last result', secondary: true, render: (row) => <span className="gc-ellipsis" title={lastResult(row)}>{lastResult(row)}</span> },
          { key: 'probe', header: 'Checked', align: 'right', optional: true, render: (row) => formatRelative(row.lastProbeAt), sortValue: (row) => row.lastProbeAt ?? 0 },
        ]} />
    </Panel>
  )
}

function EventsPanel({ events }: { events: ReturnType<typeof useSellerEvents> }) {
  return (
    <Panel title="Recent events" description="Starts and stops, models withdrawn or restored, gas, quiet periods." actions={<PageLink to="seller-logs?view=events">All events</PageLink>}>
      <SellerEventList events={events} limit={12} />
    </Panel>
  )
}

function PaymentsPanel({ usage }: { usage?: SellerUsage }) {
  return (
    <Panel title="Payments" description="From this seller's local channel ledger.">
      {!usage ? <LoadingRows rows={1} height={40} /> : (
        <div className="gc-grid gc-grid--2 gc-figures">
          <Figure label="Settled" value={formatUsd(usage.settledUsdc)} strong />
          <Figure label="Delivered" value={formatUsd(usage.deliveredUsdc)} />
          <Figure label="Channels open" value={formatNumber(usage.channels.active)} />
          <Figure label="Channels settled" value={formatNumber(usage.channels.settled)} />
        </div>
      )}
    </Panel>
  )
}
