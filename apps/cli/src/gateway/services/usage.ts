import { badRequest, notFound } from '../console-api/serialize.js'
import type { RequestDetail, RequestLogEntry, UsageReport, UsageTotals } from '../console-api/types.js'
import { usdcToDecimalString } from '../money.js'
import type { GatewayStore, RequestCursor, RequestLogFilter, RequestLogRow, UsageFilter, UsageGroupBy, UsageTotalsRow } from '../store.js'

const USAGE_GROUP_BYS: readonly UsageGroupBy[] = ['hour', 'day', 'model', 'key', 'member', 'peer', 'workspace', 'user']
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_USAGE_RANGE_MS = 30 * DAY_MS
const MAX_REQUEST_PAGE = 200
const MAX_EXPORT_ROWS = 100_000
const EXPORT_BATCH = 1_000
const MAX_QUERY = 200

/** Epoch milliseconds or an ISO date; null when absent. */
export function parseTime(raw: string | null | undefined, name: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const value = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
  if (!Number.isFinite(value)) throw badRequest(`${name} must be epoch milliseconds or an ISO date`)
  return value
}

/** `success`/`ok`, `error` or an HTTP status code; null when absent. */
export function parseStatusFilter(raw: string | null | undefined): 'ok' | 'error' | number | null {
  if (!raw) return null
  if (raw === 'ok' || raw === 'success') return 'ok'
  if (raw === 'error') return 'error'
  if (/^\d{3}$/.test(raw)) return Number(raw)
  throw badRequest('status must be success, error or an HTTP status code')
}

export function parseGroupBy(raw: string | null | undefined, name = 'groupBy'): UsageGroupBy | null {
  if (!raw) return null
  if (!USAGE_GROUP_BYS.includes(raw as UsageGroupBy)) throw badRequest(`${name} must be one of ${USAGE_GROUP_BYS.join(', ')}`)
  return raw as UsageGroupBy
}

/**
 * `groupBy` and `splitBy` of a usage report. `groupBy=day,model` is short
 * for `groupBy=day&splitBy=model`. A split needs a grouping and must differ
 * from it.
 */
export function parseGrouping(groupByRaw: string | null | undefined, splitByRaw: string | null | undefined): { groupBy: UsageGroupBy | null; splitBy: UsageGroupBy | null } {
  const [first, second, ...rest] = (groupByRaw ?? '').split(',').map((part) => part.trim())
  if (rest.length > 0) throw badRequest('groupBy takes at most two groupings')
  if (second && splitByRaw) throw badRequest('Pass the split either in groupBy or as splitBy, not both')
  const groupBy = parseGroupBy(first)
  const splitBy = parseGroupBy(second || splitByRaw, 'splitBy')
  if (splitBy && !groupBy) throw badRequest('splitBy needs a groupBy')
  if (splitBy && splitBy === groupBy) throw badRequest('splitBy must differ from groupBy')
  return { groupBy, splitBy }
}

export function parseSearch(raw: string | null | undefined): string | null {
  const q = raw?.trim() || null
  if (q && q.length > MAX_QUERY) throw badRequest(`q is longer than ${MAX_QUERY} characters`)
  return q
}

function totalsDto(row: UsageTotalsRow): UsageTotals {
  return {
    requests: row.requests,
    failedRequests: row.failedRequests,
    spent: usdcToDecimalString(row.spentUsdc),
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
  }
}

function groupLabel(store: GatewayStore, groupBy: UsageGroupBy, group: string | null): string {
  if (group === null) return groupBy === 'user' ? '(no end user)' : '(none)'
  if (groupBy === 'key') return store.getKey(group)?.label ?? group
  if (groupBy === 'member') return store.getMember(group)?.label ?? group
  if (groupBy === 'workspace') return store.getWorkspace(group)?.name ?? group
  return group
}

export function requestDto(row: RequestLogRow): RequestLogEntry {
  return {
    tag: row.tag,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    keyId: row.keyId,
    keyLabel: row.keyLabel,
    workspaceId: row.workspaceId,
    memberId: row.memberId,
    endUser: row.endUser,
    method: row.method,
    path: row.path,
    model: row.model,
    status: row.status,
    sellerPeerId: row.sellerPeerId,
    latencyMs: row.latencyMs,
    spent: row.spentUsdc === null ? null : usdcToDecimalString(row.spentUsdc),
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    ...(row.costPending ? { costPending: true } : {}),
  }
}

/** Opaque request-log cursor: base64url of `[startedAt, tag]`. */
export function encodeCursor(cursor: RequestCursor): string {
  return Buffer.from(JSON.stringify([cursor.startedAt, cursor.tag]), 'utf8').toString('base64url')
}

/** Also accepts a bare epoch-ms `before` (rows strictly older than it). */
export function decodeCursor(raw: string | null | undefined): RequestCursor | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (/^\d+$/.test(raw)) return { startedAt: Number(raw), tag: '' }
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(parsed) && parsed.length === 2 && Number.isSafeInteger(parsed[0]) && typeof parsed[1] === 'string') {
      return { startedAt: parsed[0] as number, tag: parsed[1] }
    }
  } catch {
    // fall through
  }
  throw badRequest('before is not a valid cursor')
}

/**
 * Totals and per-group rows over `[from, to]` (default: the last 30 days).
 * `filter.keyIds` limits the report to the keys the caller may see (null: all).
 */
export function usageReport(
  store: GatewayStore,
  filter: UsageFilter,
  options: { from?: number | null; to?: number | null; groupBy?: UsageGroupBy | null; splitBy?: UsageGroupBy | null; now: number },
): UsageReport {
  const to = options.to ?? options.now
  const from = options.from ?? to - DEFAULT_USAGE_RANGE_MS
  const groupBy = options.groupBy ?? null
  const splitBy = groupBy ? options.splitBy ?? null : null
  const report = store.usageReport({ ...filter, from, to }, groupBy, splitBy)
  const labels = new Map<string, string>()
  const label = (by: UsageGroupBy, group: string | null): string => {
    const cacheKey = `${by}:${group ?? ''}`
    let found = labels.get(cacheKey)
    if (found === undefined) {
      found = groupLabel(store, by, group)
      labels.set(cacheKey, found)
    }
    return found
  }
  return {
    from,
    to,
    totals: totalsDto(report.totals),
    groups: groupBy
      ? report.groups.map((row) => ({
        group: row.group ?? '',
        label: label(groupBy, row.group),
        ...totalsDto(row),
        ...(splitBy ? { splits: (row.splits ?? []).map((part) => ({ group: part.group ?? '', label: label(splitBy, part.group), ...totalsDto(part) })) } : {}),
      }))
      : [],
  }
}

/** One page of the request log, newest first, and the cursor of the next one. */
export function listRequestPage(
  store: GatewayStore,
  filter: RequestLogFilter,
  options: { before?: RequestCursor | null; limit?: number } = {},
): { requests: RequestLogEntry[]; nextBefore: string | null } {
  const raw = options.limit ?? 50
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(MAX_REQUEST_PAGE, Math.floor(raw))) : 50
  const rows = store.listRequests({ ...filter, before: options.before ?? null, limit: limit + 1 })
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return { requests: page.map(requestDto), nextBefore: rows.length > limit && last ? encodeCursor(last) : null }
}

/** One request with its stored bodies (when content logging is on). */
export function requestDetail(store: GatewayStore, tag: string, keyIds: readonly string[] | null): RequestDetail {
  const row = store.getRequest(tag, keyIds)
  if (!row) throw notFound('Request')
  return { ...requestDto(row), requestBody: row.requestBody, responseBody: row.responseBody }
}

/** Explicit export columns: never request or response bodies. */
const CSV_COLUMNS: ReadonlyArray<keyof RequestLogEntry> = [
  'tag', 'startedAt', 'finishedAt', 'keyId', 'keyLabel', 'workspaceId', 'memberId', 'endUser', 'method', 'path',
  'model', 'status', 'sellerPeerId', 'latencyMs', 'spent', 'inputTokens', 'cachedInputTokens', 'outputTokens',
  'errorCode', 'errorMessage',
]

/** RFC 4180 quoting; cells that a spreadsheet would run as a formula are prefixed with a quote. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The request-log CSV export, as chunks: the header, then a batch of rows at
 * a time in cursor order, so memory stays flat however many rows match
 * (capped at `MAX_EXPORT_ROWS`). `stopped()` ends it early (client gone).
 */
export function* requestCsvChunks(
  store: GatewayStore,
  filter: RequestLogFilter,
  options: { before?: RequestCursor | null; stopped?: () => boolean } = {},
): Generator<string> {
  yield `${CSV_COLUMNS.join(',')}\r\n`
  let before = options.before ?? null
  let written = 0
  while (written < MAX_EXPORT_ROWS && !options.stopped?.()) {
    const rows = store.listRequests({ ...filter, before, limit: Math.min(EXPORT_BATCH, MAX_EXPORT_ROWS - written) })
    if (rows.length === 0) break
    let chunk = ''
    for (const row of rows) {
      const entry = requestDto(row)
      chunk += `${CSV_COLUMNS.map((column) => csvCell(entry[column])).join(',')}\r\n`
    }
    yield chunk
    written += rows.length
    const last = rows[rows.length - 1]!
    before = { startedAt: last.startedAt, tag: last.tag }
    if (rows.length < EXPORT_BATCH) break
  }
}
