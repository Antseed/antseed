import { useMemo, useState, type ReactNode } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Alert, Button, DataTable, Drawer, TextField } from '@antseed/ui'
import { api } from '../api'
import type { SellerLogDetail, SellerLogEntry, SellerLogQuery } from '../api/types'
import { Icon } from '../components/icons'
import { statusBadge } from '../components/RequestLog'
import { SellerEventList } from '../components/SellerEvents'
import { SellerPage } from '../components/SellerPage'
import { CopyButton, DetailList, EmptyState, ErrorAlert, LoadingRows, Mono, Panel, Segmented, SelectField } from '../components/ui'
import { formatDateTime, formatLatency, formatNumber, formatPricePerMillion, formatUsd, shortId } from '../lib/format'
import { qk, useSellerEvents, useSellerSettings } from '../lib/queries'
import { useDebounced } from '../lib/useDebounced'
import '../styles/seller.scss'

const PAGE_SIZE = 50
const RANGES: Array<{ value: string; label: string; ms: number | null }> = [
  { value: 'all', label: 'Any time', ms: null },
  { value: '1h', label: 'Last hour', ms: 3_600_000 },
  { value: '24h', label: 'Last 24 hours', ms: 86_400_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
]
type View = 'requests' | 'events'

/** The seller's request log (metering.db, failures included) and its event journal. */
export default function SellerLogs() {
  const [view, setView] = useState<View>(() => (new URLSearchParams(window.location.search).get('view') === 'events' ? 'events' : 'requests'))
  return (
    <SellerPage title="Logs" description={() => 'Every request this seller passed to a provider, failures included, newest first, and its events.'}
      actions={<Segmented label="Show" value={view} onChange={setView} options={[{ value: 'requests', label: 'Requests' }, { value: 'events', label: 'Events' }]} />}>
      {() => (view === 'requests' ? <Requests /> : <Events />)}
    </SellerPage>
  )
}

function Events() {
  const events = useSellerEvents()
  return <Panel title="Events" description="Starts and stops, models withdrawn or restored, gas, quiet periods, alerts."><SellerEventList events={events} /></Panel>
}

function Requests() {
  const [model, setModel] = useState('')
  const [buyer, setBuyer] = useState('')
  const [range, setRange] = useState('all')
  const [status, setStatus] = useState<'all' | 'errors'>('all')
  const [selected, setSelected] = useState<SellerLogEntry | null>(null)
  // Typed filters query metering.db once typing pauses, not on every keystroke.
  const modelFilter = useDebounced(model.trim())
  const buyerFilter = useDebounced(buyer.trim())
  // The model filter matches a model id exactly; suggest the seller's own.
  const models = [...new Set(useSellerSettings().data?.settings.services.map((entry) => entry.service) ?? [])]
  // Fixed per filter change, so the cursor keys stay stable while paging.
  const filter = useMemo<SellerLogQuery>(() => {
    const ms = RANGES.find((entry) => entry.value === range)?.ms ?? null
    return { service: modelFilter || null, buyer: buyerFilter || null, from: ms === null ? null : Date.now() - ms, errorsOnly: status === 'errors', limit: PAGE_SIZE }
  }, [modelFilter, buyerFilter, range, status])
  const query = useInfiniteQuery({
    queryKey: qk.sellerLogs(filter),
    queryFn: ({ pageParam }) => api.seller.logs({ ...filter, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  })
  const rows = query.data?.pages.flatMap((page) => page.entries) ?? []
  const filtered = Boolean(model || buyer || range !== 'all' || status !== 'all')

  return (
    <>
      <div className="gc-toolbar">
        <TextField size="sm" aria-label="Filter by model id (exact)" placeholder="Model id" list="gc-seller-log-models" value={model} onChange={(event) => setModel(event.target.value)} />
        <datalist id="gc-seller-log-models">{models.map((id) => <option key={id} value={id} />)}</datalist>
        <TextField size="sm" aria-label="Filter by buyer" placeholder="Buyer peer id" value={buyer} onChange={(event) => setBuyer(event.target.value)} className="gc-toolbar__grow" />
        <SelectField size="sm" aria-label="Time range" value={range} onChange={setRange} options={RANGES.map(({ value, label }) => ({ value, label }))} />
        <SelectField size="sm" aria-label="Filter by status" value={status} onChange={(value) => setStatus(value as 'all' | 'errors')}
          options={[{ value: 'all', label: 'All statuses' }, { value: 'errors', label: 'Failed only' }]} />
      </div>
      <Panel flush>
        {query.isLoading ? <LoadingRows rows={8} /> : query.error && !query.data ? <ErrorAlert error={query.error} onRetry={() => void query.refetch()} /> : (
          <>
            <DataTable<SellerLogEntry> label="Seller request log" rows={rows} rowKey={(row) => row.id} onRowClick={setSelected}
              empty={query.hasNextPage
                // A filtered page reads a bounded stretch of the log; older requests may still match.
                ? <EmptyState icon={<Icon.logs size={18} />} title="No matching requests in the latest scanned range" body="Older requests may still match. Look further back, or widen the filters." />
                : <EmptyState icon={<Icon.logs size={18} />} title={filtered ? 'No requests match' : 'No requests yet'} body={filtered ? 'Widen the filters.' : 'Requests appear here as buyers use this seller.'} />}
              columns={[
                { key: 'time', header: 'Time', render: (row) => <span className="gc-nowrap">{formatDateTime(row.at)}</span> },
                { key: 'buyer', header: 'Buyer', secondary: true, render: (row) => <Mono title={row.buyer}>{shortId(row.buyer)}</Mono> },
                { key: 'model', header: 'Model', render: (row) => (row.service ? <span className="gc-ellipsis" title={row.service}>{row.service}</span> : <span className="gc-muted" title="Recorded before sellers kept the model">{row.provider}</span>) },
                { key: 'status', header: 'Status', render: (row) => <span title={row.error ?? undefined}>{statusBadge(row.statusCode)}</span> },
                { key: 'tokens', header: 'Tokens', align: 'right', secondary: true, render: (row) => <span title={row.exactTokens ? 'As the upstream reported them' : 'Estimated from the body size'}>{formatNumber(row.inputTokens)} → {formatNumber(row.outputTokens)}{row.exactTokens ? '' : '*'}</span> },
                { key: 'latency', header: 'Latency', align: 'right', optional: true, render: (row) => formatLatency(row.latencyMs) },
                { key: 'cost', header: 'Cost', align: 'right', render: (row) => (row.costUsd === null ? <span className="gc-muted">—</span> : formatUsd(row.costUsd)) },
              ]} />
            {query.hasNextPage && (
              <div className="gc-load-more">
                <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  {query.isFetchingNextPage ? 'Loading…' : rows.length === 0 ? 'Look further back' : 'Load older requests'}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
      <Drawer isOpen={selected !== null} onClose={() => setSelected(null)} title={selected ? (selected.service ?? selected.provider) : 'Request'}
        subtitle={selected ? formatDateTime(selected.at) : undefined} eyebrow="Request">
        {selected && <RequestDetailView key={selected.id} entry={selected}
          onBuyer={(peerId) => { setBuyer(peerId); setSelected(null) }}
          onModel={(service) => { setModel(service); setSelected(null) }} />}
      </Drawer>
      <p className="gc-fineprint">Cost comes from the signed usage receipt (whole cents). Tokens marked * were estimated from the body size because the upstream did not report usage.</p>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div className="gc-stack gc-stack--tight"><div className="as-field__label">{title}</div>{children}</div>
}

/** Everything the seller kept about one request: the failure, tokens, the signed receipt, the session and the buyer's channel. */
function RequestDetailView({ entry, onBuyer, onModel }: { entry: SellerLogEntry; onBuyer: (peerId: string) => void; onModel: (service: string) => void }) {
  const detail = useQuery({ queryKey: qk.sellerLog(entry.id), queryFn: () => api.seller.logDetail(entry.id), retry: false, staleTime: 60_000 })
  const data: SellerLogEntry & Partial<SellerLogDetail> = detail.data ?? entry
  const failed = data.statusCode >= 400 || data.error
  return (
    <div className="gc-stack">
      {failed ? <Alert tone="danger" title={`HTTP ${data.statusCode}`}>{data.error ?? 'No reason was recorded for this request (older requests did not keep one).'}</Alert> : null}
      <DetailList items={[
        ['Status', <span key="s">{statusBadge(data.statusCode)}{data.streaming ? <span className="gc-muted"> streamed</span> : null}</span>],
        ['Model', data.service ?? <span key="m" className="gc-muted">not recorded (older request)</span>],
        ['Upstream', data.provider],
        ['Buyer', <span key="b" className="gc-nowrap"><Mono>{data.buyer}</Mono> <CopyButton value={data.buyer} /></span>],
        ['Latency', formatLatency(data.latencyMs)],
        ['Input tokens', formatNumber(data.inputTokens)],
        ['Cached input', data.cachedInputTokens === null ? '—' : formatNumber(data.cachedInputTokens)],
        ['Output tokens', formatNumber(data.outputTokens)],
        ['Token count', data.exactTokens ? 'Reported by the upstream' : 'Estimated from the body size'],
        ['Cost', data.costUsd === null || data.costUsd === 0 ? <span key="c" className="gc-muted">{failed ? 'Not charged' : 'Free'}</span> : formatUsd(data.costUsd)],
        ['Id', <span key="i" className="gc-nowrap"><Mono>{data.id}</Mono> <CopyButton value={data.id} /></span>],
      ]} />
      <div className="gc-toolbar">
        <Button variant="outline" size="sm" onClick={() => onBuyer(data.buyer)}>This buyer's requests</Button>
        {data.service ? <Button variant="outline" size="sm" onClick={() => onModel(data.service!)}>All {data.service} requests</Button> : null}
      </div>
      {detail.isLoading && <LoadingRows rows={3} />}
      {detail.error ? <ErrorAlert error={detail.error} title="Could not load the details" /> : null}
      {detail.data && <PaymentDetail detail={detail.data} />}
    </div>
  )
}

function PaymentDetail({ detail }: { detail: SellerLogDetail }) {
  const { receipt, session, channel } = detail
  const check = receipt?.buyerCheck ?? null
  return (
    <>
      <Section title="Receipt">
        {receipt ? (
          <DetailList items={[
            ['Signed price', receipt.usdPerMillionTokens === 0 ? 'Free' : `${formatPricePerMillion(receipt.usdPerMillionTokens)} / 1M tokens`],
            ['Buyer check', check
              ? `${check.signatureValid ? 'Signature valid' : 'Signature invalid'} · buyer counted ${formatNumber(check.buyerTokens)} tokens (${check.differencePercent.toFixed(1)}% off)${check.disputed ? ' · disputed' : ''}`
              : <span key="c" className="gc-muted">Not checked yet</span>],
            ['Receipt', <Mono key="r">{receipt.id}</Mono>],
          ]} />
        ) : <p className="gc-fineprint">No signed receipt: free requests and failed ones are not billed.</p>}
      </Section>
      <Section title="Session">
        <DetailList items={[
          ['Position', session.requests ? `Request ${session.position} of ${session.requests}` : `Request ${session.position}`],
          ['Started', formatDateTime(session.startedAt)],
          ['Tokens', session.tokens === null ? '—' : formatNumber(session.tokens)],
          ['Cost', session.costUsd === null ? '—' : formatUsd(session.costUsd)],
          ['Average latency', formatLatency(session.avgLatencyMs)],
        ]} />
      </Section>
      <Section title="Payment channel">
        {channel ? (
          <DetailList items={[
            ['Kind', channel.oneOff ? 'One-off (this request only)' : 'Regular'],
            ['Status', channel.status],
            ['Opened', formatDateTime(channel.openedAt)],
            ['Delivered', `${formatUsd(channel.deliveredUsd)} of ${formatUsd(channel.authorizedUsd)} authorized`],
            ['Settled', channel.settledUsd === null ? <span key="s" className="gc-muted">Not yet</span> : `${formatUsd(channel.settledUsd)} · ${formatDateTime(channel.settledAt)}`],
            ['Requests', formatNumber(channel.requests)],
            ['Channel', <Mono key="c">{shortId(channel.id)}</Mono>],
          ]} />
        ) : <p className="gc-fineprint">No channel was open with this buyer at the time (a free request, or one refused before payment).</p>}
      </Section>
    </>
  )
}
