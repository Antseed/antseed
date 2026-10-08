import {
  decodeCursor,
  listRequestPage,
  parseGrouping,
  parseSearch,
  parseStatusFilter,
  parseTime,
  requestCsvChunks,
  requestDetail,
  usageReport,
} from '../../services/usage.js'
import type { GatewayStore, RequestLogFilter, UsageFilter } from '../../store.js'
import { canSeeWorkspace, visibleKeyIds } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, type ConsoleRouter, type Principal } from '../router.js'

/** Filters from the query, limited to what the caller may see. */
function scopedFilter(store: GatewayStore, principal: Principal | null, query: URLSearchParams): UsageFilter {
  const workspaceId = query.get('workspace')
  if (workspaceId && principal?.kind !== 'key' && !canSeeWorkspace(store, principal, workspaceId)) {
    throw new ConsoleError(403, 'forbidden', 'You are not a member of this workspace')
  }
  return {
    keyIds: visibleKeyIds(store, principal),
    workspaceId: workspaceId || null,
    keyId: query.get('key') || null,
    memberId: query.get('member') || null,
    model: query.get('model') || null,
  }
}

/** The request-log filters shared by `/requests` and the CSV export. */
function requestFilter(store: GatewayStore, principal: Principal | null, query: URLSearchParams): RequestLogFilter {
  const q = parseSearch(query.get('q'))
  return {
    ...scopedFilter(store, principal, query),
    from: parseTime(query.get('from'), 'from'),
    to: parseTime(query.get('to'), 'to'),
    status: parseStatusFilter(query.get('status')),
    q,
  }
}

/**
 * Usage reports, the request log and its CSV export (see
 * `services/usage.ts`). Every query is limited to the keys the caller may
 * see: all for org admins and tokens, a workspace's keys for its admins, a
 * member's own keys otherwise, and the one key for an API-key session.
 */
export function registerUsageRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps
  const allow = ['member', 'token', 'key'] as const

  router.add('GET', '/usage', async ({ principal, query }) => {
    const filter = scopedFilter(store, principal, query)
    const to = parseTime(query.get('to'), 'to')
    const from = parseTime(query.get('from'), 'from')
    return usageReport(store, filter, { from, to, ...parseGrouping(query.get('groupBy'), query.get('splitBy')), now: deps.now() })
  }, { allow })

  router.add('GET', '/requests', async ({ principal, query }) => {
    const filter = requestFilter(store, principal, query)
    return listRequestPage(store, filter, { before: decodeCursor(query.get('before')), limit: Number(query.get('limit') ?? 50) })
  }, { allow })

  router.add('GET', '/requests/:tag', async ({ principal, params }) => {
    return requestDetail(store, params['tag']!, visibleKeyIds(store, principal))
  }, { allow })

  /** Streams the export page by page (cursor order), so memory stays flat however many rows match. */
  router.add('GET', '/usage/export.csv', async ({ principal, query, res }) => {
    const filter = requestFilter(store, principal, query)
    const before = decodeCursor(query.get('before'))
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="antseed-usage-${new Date(deps.now()).toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    })
    for (const chunk of requestCsvChunks(store, filter, { before, stopped: () => res.destroyed })) {
      if (!res.write(chunk)) await new Promise<void>((resolve) => { res.once('drain', resolve); res.once('close', resolve) })
    }
    res.end()
    return undefined
  }, { allow })
}
