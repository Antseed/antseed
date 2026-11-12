import { useState } from 'react'
import { BarChart, DataTable, type DataTableColumn } from '@antseed/ui'
import type { SellerUsage, SellerWorker } from '../api/types'
import { Badge, EmptyState, ErrorAlert, Figure, LoadingRows, PageLink, Panel, Segmented, StatTile } from '../components/ui'
import { formatDuration, formatNumber, formatRelative, formatUsd, shortId } from '../lib/format'
import { useSellerEvents, useSellerUsage, useSellerWorkers } from '../lib/queries'
import { formatEth, formatUtcDay, lastResult, sellerNotices, usageTotals, type AvailableSeller } from '../lib/seller'
import { SellerPage } from '../components/SellerPage'
import { SellerEventList } from '../components/SellerEvents'
import '../styles/seller.scss'

const DAYS = 14
/** Failing models sort first, then unchecked ones. */
const STATUS_SORT_ORDER: Record<AvailableSeller['models'][number]['status'], number> = { failing: 0, unknown: 1, healthy: 2 }
type ChartMetric = 'requests' | 'revenue'
const CHART_METRICS: Array<{ value: ChartMetric; label: string }> = [
  { value: 'requests', label: 'Requests' },
  { value: 'revenue', label: 'Revenue' },
]

/** The seller on this host: live status, model health, gas, earnings and recent events. */
export default function Seller() {
  return <SellerPage title="Seller" live description={headerLine}>{(seller) => <Overview seller={seller} />}</SellerPage>
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
      <WorkersPanel />
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
        sub={gas ? (gas.depleted ? 'Below minimum, advertising paused' : gasSub(gas)) : 'No gas checks (payments off)'} />
    </div>
  )
}

function gasSub(gas: NonNullable<AvailableSeller['gas']>): string {
  if (!gas.refuel) return `Minimum ${formatEth(gas.minBalanceEth)} ETH`
  return gas.refuel.lastRefuel
    ? `Auto-refuel: ${gas.refuel.lastRefuel.usdc} USDC swapped ${formatRelative(gas.refuel.lastRefuel.at)}`
    : `Auto-refuel below ${formatEth(gas.refuel.triggerBalanceEth)} ETH`
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
    <Panel title="Models" description="Buyer traffic counts as a health check, and idle services are probed. A service that keeps failing is announced as failing, so buyers skip it until it recovers." flush>
      <DataTable<Row> label="Model health" rows={seller.models} rowKey={(row) => `${row.providerId}/${row.service}`}
        empty={<EmptyState title="No health data yet" body="Model health appears once the seller has run its first checks." />}
        columns={[
          { key: 'service', header: 'Service', render: (row) => <span className="gc-ellipsis" title={row.service}>{row.service}</span>, sortValue: (row) => row.service },
          { key: 'provider', header: 'Provider', secondary: true, render: (row) => row.provider, sortValue: (row) => row.provider },
          {
            key: 'status', header: 'Status', sortValue: (row) => STATUS_SORT_ORDER[row.status],
            render: (row) => (row.status === 'failing'
              ? <Badge tone="warning">Failing</Badge>
              : <Badge tone="neutral">{row.status === 'healthy' ? 'Healthy' : 'Not checked'}</Badge>),
          },
          { key: 'failures', header: 'Failures', align: 'right', render: (row) => formatNumber(row.consecutiveFailures), sortValue: (row) => row.consecutiveFailures },
          { key: 'last', header: 'Last result', secondary: true, render: (row) => <span className="gc-ellipsis" title={lastResult(row)}>{lastResult(row)}</span> },
          { key: 'probe', header: 'Checked', align: 'right', optional: true, render: (row) => formatRelative(row.checkedAt ?? row.lastProbeAt), sortValue: (row) => row.checkedAt ?? row.lastProbeAt ?? 0 },
        ]} />
    </Panel>
  )
}

/** A worker's display name: the name its app announced, else its address. */
function workerName(worker: SellerWorker): string {
  return worker.agent?.match(/\(([^)]+)\)\s*$/)?.[1] ?? shortId(worker.address)
}

/** Online, benched (amber dot, one line), excluded by the operator, or when it was last seen. */
function workerStatus(row: SellerWorker) {
  if (!row.connected) return <span className="gc-muted">{`Seen ${formatRelative(row.lastSeenAt)}`}</span>
  if (row.benchedUntil !== null) {
    return <span className="gc-health-failing" title="It failed to answer a request; the pool routes nothing to it until then"><span className="gc-attention" aria-hidden="true" />{`Benched, back in ${formatDuration(row.benchedUntil - Date.now())}`}</span>
  }
  if (row.priority === 0) return <span className="gc-muted" title="COLONY_POOL_WORKER_PRIORITY gives it weight 0">Not routed</span>
  return <Badge tone="neutral">Online</Badge>
}

const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`)

const WORKER_COLUMNS: DataTableColumn<SellerWorker>[] = [
  { key: 'rank', header: 'Rank', align: 'right', render: (row) => (row.rank === null ? '—' : `#${row.rank}`), sortValue: (row) => row.rank ?? Infinity },
  { key: 'name', header: 'Worker', render: (row) => <span className="gc-ellipsis" title={row.address}>{workerName(row)}</span>, sortValue: (row) => workerName(row) },
  {
    key: 'status', header: 'Status', sortValue: (row) => (!row.connected ? 3 : row.benchedUntil !== null ? 1 : row.priority === 0 ? 2 : 0),
    render: workerStatus,
  },
  {
    key: 'answered', header: 'Answered (24h)', align: 'right', render: (row) => percent(row.successRateDay), sortValue: (row) => row.successRateDay ?? -1,
  },
  {
    key: 'answeredWeek', header: 'Answered (7d)', align: 'right', optional: true, render: (row) => percent(row.successRateWeek), sortValue: (row) => row.successRateWeek ?? -1,
  },
  {
    key: 'firstByte', header: 'First byte', align: 'right', optional: true,
    render: (row) => (row.firstByteMsMedian === null ? '—' : row.firstByteMsMedian < 1000 ? `${Math.round(row.firstByteMsMedian)} ms` : `${(row.firstByteMsMedian / 1000).toFixed(1)} s`),
    sortValue: (row) => row.firstByteMsMedian ?? Infinity,
  },
  { key: 'speed', header: 'Speed', align: 'right', render: (row) => (row.tokensPerSecond === null ? '—' : `${formatNumber(Math.round(row.tokensPerSecond))} tok/s`), sortValue: (row) => row.tokensPerSecond ?? 0 },
  { key: 'requests', header: 'Requests (7d)', align: 'right', render: (row) => formatNumber(row.requestsWeek), sortValue: (row) => row.requestsWeek },
  { key: 'online', header: 'Online (7d)', align: 'right', optional: true, render: (row) => `${formatNumber(Math.round(row.onlineHoursWeek))} h`, sortValue: (row) => row.onlineHoursWeek },
  { key: 'earned', header: 'Earned (7d)', align: 'right', render: (row) => formatUsd(row.earnedWeekUsdc), sortValue: (row) => row.earnedWeekUsdc },
  { key: 'total', header: 'Earned total', align: 'right', secondary: true, render: (row) => formatUsd(row.earnedTotalUsdc), sortValue: (row) => row.earnedTotalUsdc },
]

/** Only for a seller running the colony-pool provider: the Macs serving it, in the pool's routing order. */
function WorkersPanel() {
  const workers = useSellerWorkers()
  if (!workers.data?.available) return null
  return (
    <Panel title="Workers" description="Macs serving this seller's colony pool, in the order the pool sends them buyers (reliability, speed and your priority weights). Earnings are each worker's share after the protocol fee and your pool's cut; the pool contract pays them at settlement." flush>
      <DataTable<SellerWorker> label="Workers" rows={workers.data.workers} rowKey={(row) => row.address}
        empty={<EmptyState title="No workers yet" body="Workers appear here once a Mac joins the pool." />}
        columns={WORKER_COLUMNS} />
    </Panel>
  )
}

function EventsPanel({ events }: { events: ReturnType<typeof useSellerEvents> }) {
  return (
    <Panel title="Recent events" description="Starts and stops, models failing or recovered, gas, quiet periods." actions={<PageLink to="seller-logs?view=events">All events</PageLink>}>
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
