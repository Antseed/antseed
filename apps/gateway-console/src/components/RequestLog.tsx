import { useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Alert, Button, DataTable, Drawer } from '@antseed/ui'
import { api, isApiError, type RequestQuery } from '../api'
import type { RequestDetail, RequestLogEntry } from '../api/types'
import { formatDateTime, formatLatency, formatNumber, formatUsd, shortId } from '../lib/format'
import { qk } from '../lib/queries'
import { costStatus } from '../lib/usage'
import { Badge, CodeBlock, DetailList, EmptyState, ErrorAlert, LoadingRows, Mono } from './ui'
import { Icon } from './icons'

export type RequestFilter = RequestQuery

const PAGE_SIZE = 50

function statusBadge(status: number | null) {
  if (status === null) return <Badge tone="info">In flight</Badge>
  if (status < 400) return <Badge tone="success">{status}</Badge>
  if (status < 500) return <Badge tone="warning">{status}</Badge>
  return <Badge tone="danger">{status}</Badge>
}

/** Cost of a request; "pending" until the buyer reports its spend, "not recorded" if it never does. */
function Cost({ entry }: { entry: RequestLogEntry }) {
  const status = costStatus(entry, Date.now())
  if (status === 'pending') return <span className="gc-muted" title="The buyer reports spend a moment after the response">pending</span>
  if (status === 'not-recorded') {
    return <span className="gc-muted" title="No spend was reported for this request: a free seller, or spend the buyer lost">not recorded</span>
  }
  return <>{formatUsd(entry.spent)}</>
}

/** Pretty-prints JSON bodies; anything else is shown as is. */
function formatBody(body: string): string {
  try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body }
}

function BodyBlock({ title, body }: { title: string; body: string }) {
  return <div className="gc-stack gc-stack--tight"><div className="as-field__label">{title}</div><CodeBlock code={formatBody(body)} /></div>
}

/** The stored request and response bodies, or a note on how to keep them. */
function RequestBodies({ detail }: { detail: RequestDetail }) {
  if (!detail.requestBody && !detail.responseBody) {
    return <p className="gc-fineprint">Bodies are not stored for this request. Turn on content logging under Settings → Observability to keep them.</p>
  }
  return (
    <>
      {detail.requestBody && <BodyBlock title="Request body" body={detail.requestBody} />}
      {detail.responseBody && <BodyBlock title="Response body" body={detail.responseBody} />}
    </>
  )
}

function RequestDetailView({ entry }: { entry: RequestLogEntry }) {
  const detail = useQuery({
    queryKey: qk.request(entry.tag),
    queryFn: () => api.usage.request(entry.tag),
    retry: false,
    staleTime: 60_000,
  })
  // Older gateways have no detail route; the list row still has everything but the bodies.
  const data: RequestLogEntry & Partial<Pick<RequestDetail, 'requestBody' | 'responseBody'>> = detail.data ?? entry
  const missingRoute = isApiError(detail.error) && detail.error.status === 404
  return (
    <>
      {data.errorCode || data.errorMessage ? (
        <Alert tone="danger" title={data.errorCode ?? 'Request failed'}>{data.errorMessage ?? 'No message was returned.'}</Alert>
      ) : null}
      <DetailList items={[
        ['Status', statusBadge(data.status)],
        ['Request', <Mono key="p">{data.method} {data.path}</Mono>],
        ['Model', data.model ?? '—'],
        ['Key', data.keyLabel],
        ['End user', data.endUser ?? '—'],
        ['Seller', data.sellerPeerId ? <Mono key="s">{data.sellerPeerId}</Mono> : '—'],
        ['Latency', formatLatency(data.latencyMs)],
        ['Duration', data.finishedAt ? formatLatency(data.finishedAt - data.startedAt) : '—'],
        ['Input tokens', formatNumber(data.inputTokens)],
        ['Cached input', formatNumber(data.cachedInputTokens)],
        ['Output tokens', formatNumber(data.outputTokens)],
        ['Cost', <Cost key="c" entry={data} />],
        ['Tag', <Mono key="t">{data.tag}</Mono>],
      ]} />
      {detail.isLoading && <LoadingRows rows={2} />}
      {detail.error && !missingRoute ? <ErrorAlert error={detail.error} title="Could not load the bodies" /> : null}
      {detail.data && <RequestBodies detail={detail.data} />}
    </>
  )
}

/** Cursor-paginated request log with a detail drawer; shared by Logs and the key-holder view. */
export function RequestLog({ filter, showKey = true }: { filter: RequestFilter; showKey?: boolean }) {
  const [selected, setSelected] = useState<RequestLogEntry | null>(null)
  const query = useInfiniteQuery({
    queryKey: qk.requests(filter),
    queryFn: ({ pageParam }) => api.usage.requests({ ...filter, before: pageParam ?? undefined, limit: PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    // Refresh while a recent request still waits for its spend.
    refetchInterval: (current) =>
      current.state.data?.pages.some((page) => page.requests.some((row) => costStatus(row, Date.now()) === 'pending')) ? 5_000 : false,
  })

  if (query.isLoading) return <LoadingRows rows={8} />
  if (query.error) return <ErrorAlert error={query.error} onRetry={() => void query.refetch()} />
  const rows = query.data?.pages.flatMap((page) => page.requests) ?? []

  return (
    <>
      <DataTable<RequestLogEntry> label="Request log" rows={rows} rowKey={(row) => row.tag} onRowClick={setSelected}
        rowLabel={(row) => `request ${row.tag}`}
        empty={<EmptyState icon={<Icon.logs size={18} />} title="No requests found" body="Requests appear here as soon as a key is used. Check the filters if you expected some." />}
        columns={[
          { key: 'time', header: 'Time', render: (row) => <span className="gc-nowrap">{formatDateTime(row.startedAt)}</span> },
          ...(showKey ? [{ key: 'key', header: 'Key', secondary: true, render: (row: RequestLogEntry) => row.keyLabel }] : []),
          { key: 'model', header: 'Model', render: (row) => (
            <span className="gc-ellipsis">{row.model ?? row.path}{row.status !== null && row.status >= 400 ? <span className="gc-narrow-only"> {statusBadge(row.status)}</span> : null}</span>
          ) },
          { key: 'seller', header: 'Seller', secondary: true, optional: true, render: (row) => row.sellerPeerId ? <Mono title={row.sellerPeerId}>{shortId(row.sellerPeerId)}</Mono> : '—' },
          { key: 'status', header: 'Status', secondary: true, render: (row) => <span title={row.errorMessage ?? undefined}>{statusBadge(row.status)}</span> },
          { key: 'latency', header: 'Latency', align: 'right', secondary: true, optional: true, render: (row) => formatLatency(row.latencyMs) },
          { key: 'tokens', header: 'Tokens', align: 'right', secondary: true, render: (row) => `${formatNumber(row.inputTokens)} → ${formatNumber(row.outputTokens)}` },
          { key: 'cost', header: 'Cost', align: 'right', render: (row) => <Cost entry={row} /> },
        ]} />
      {query.hasNextPage && (
        <div className="gc-load-more">
          <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {query.isFetchingNextPage ? 'Loading…' : 'Load older requests'}
          </Button>
        </div>
      )}
      <Drawer isOpen={selected !== null} onClose={() => setSelected(null)} title={selected?.model ?? 'Request'}
        subtitle={selected ? formatDateTime(selected.startedAt) : undefined} eyebrow="Request">
        {selected && <RequestDetailView key={selected.tag} entry={selected} />}
      </Drawer>
    </>
  )
}
