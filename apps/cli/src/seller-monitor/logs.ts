import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MeteringStorage, type MeteringEventPageRow } from '@antseed/node/metering'
import { CHANNEL_KIND, ChannelStore, type StoredChannel } from '@antseed/node/payments'
import type { SellerLogDetail, SellerLogEntry, SellerLogPage, SellerLogQuery } from '../gateway/console-api/types.js'
import { ConsoleError } from '../gateway/console-api/router.js'

export const DEFAULT_LOG_PAGE = 50

/**
 * Reads the seller's live metering.db read-only (never migrating it from here).
 * A database an older seller wrote lacks the log columns until that seller restarts on this version.
 */
function readMetering<T>(path: string, read: (metering: MeteringStorage) => T): T {
  const metering = new MeteringStorage(path, { readonly: true })
  try {
    return read(metering)
  } catch (error) {
    if (/no such column/i.test((error as Error).message)) {
      throw new ConsoleError(409, 'seller_outdated', 'The seller\'s metering database is from an older version; restart the seller once on this version to read its request log.')
    }
    throw error
  } finally {
    metering.close()
  }
}

function decodeCursor(cursor: string | null | undefined): { timestamp: number; rowid: number } | undefined {
  if (!cursor) return undefined
  const [timestamp, rowid] = cursor.split('.').map(Number)
  return Number.isSafeInteger(timestamp) && Number.isSafeInteger(rowid) ? { timestamp: timestamp!, rowid: rowid! } : undefined
}

/**
 * One page of the seller's request log from metering.db, newest first:
 * keyset-paged on the timestamp index, so deep pages cost the same as the
 * first on a multi-GB database. Cost comes from the signed usage receipt.
 */
export function readSellerLogs(dataDir: string, query: SellerLogQuery = {}): SellerLogPage {
  const path = join(dataDir, 'metering.db')
  if (!existsSync(path)) return { entries: [], next: null }
  const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LOG_PAGE, 200))
  return readMetering(path, (metering) => {
    const before = decodeCursor(query.cursor)
    const { rows, scannedTo } = metering.listEventsPage({
      limit: limit + 1,
      ...(before ? { before } : {}),
      ...(query.from ? { fromMs: query.from } : {}),
      ...(query.buyer ? { buyerPeerId: query.buyer.trim().toLowerCase().replace(/^0x/, '') } : {}),
      ...(query.service ? { service: query.service.trim() } : {}),
      ...(query.errorsOnly ? { errorsOnly: true } : {}),
    })
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    // A filtered page can come back short (even empty) with more to look through: `next` then continues the walk.
    const next = rows.length > limit && last ? last : scannedTo
    return {
      entries: page.map(toEntry),
      next: next ? `${next.timestamp}.${next.rowid}` : null,
    }
  })
}

function toEntry(row: MeteringEventPageRow): SellerLogEntry {
  return {
    id: row.event_id,
    at: row.timestamp,
    buyer: row.buyer_peer_id,
    sessionId: row.session_id,
    service: row.service,
    provider: row.provider,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    exactTokens: row.token_method === 'provider-usage',
    costUsd: row.cost_cents === null ? null : row.cost_cents / 100,
    latencyMs: row.latency_ms,
    statusCode: row.status_code,
    streaming: row.was_streaming === 1,
    error: row.error ?? null,
    cachedInputTokens: row.cached_input_tokens ?? null,
  }
}

const MICRO_USDC = 1_000_000
const usd = (micro: string | null | undefined): number => {
  const value = Number(micro)
  return Number.isFinite(value) ? value / MICRO_USDC : 0
}

/** One request with its receipt, session and the buyer's payment channel at the time; null when the id is unknown. */
export function readSellerLogDetail(dataDir: string, id: string): SellerLogDetail | null {
  const path = join(dataDir, 'metering.db')
  if (!existsSync(path)) return null
  const row = readMetering(path, (metering) => metering.getEventDetail(id))
  if (!row) return null
  return {
    ...toEntry(row),
    tokenConfidence: row.token_confidence,
    receipt: row.receipt_id ? {
      id: row.receipt_id,
      // Cents per 1K tokens → USD per 1M tokens.
      usdPerMillionTokens: (row.unit_price_cents_per_thousand ?? 0) * 10,
      buyerCheck: row.verification ? {
        signatureValid: row.verification.signature_valid === 1,
        buyerTokens: row.verification.buyer_total_tokens,
        differencePercent: row.verification.percentage_difference,
        disputed: row.verification.disputed === 1,
      } : null,
    } : null,
    session: {
      id: row.session_id,
      position: row.session_position,
      startedAt: row.session?.started_at ?? null,
      endedAt: row.session?.ended_at ?? null,
      requests: row.session?.total_requests ?? null,
      tokens: row.session?.total_tokens ?? null,
      costUsd: row.session ? row.session.total_cost_cents / 100 : null,
      avgLatencyMs: row.session?.avg_latency_ms ?? null,
    },
    channel: channelFor(dataDir, row.buyer_peer_id, row.timestamp, row.request_id, Boolean(row.receipt_id) && (row.cost_cents ?? 0) > 0),
  }
}

/**
 * The channel that paid for the request: the one-off channel recorded for its
 * request id, else the regular channel with this buyer that was open when it
 * ran (newest first); none for a request that charged nothing.
 */
function channelFor(dataDir: string, buyerPeerId: string, at: number, requestId: string | null, charged: boolean): SellerLogDetail['channel'] {
  if (!existsSync(join(dataDir, 'payments', 'sessions.db'))) return null
  const store = new ChannelStore(join(dataDir, 'payments'))
  try {
    const oneOff = requestId ? store.getOneOffChannelByRequest(buyerPeerId, 'seller', requestId) : null
    if (oneOff) return channelView(oneOff)
    // A free request (no receipt, or nothing charged) was not paid from whatever channel happened to be open.
    if (!charged) return null
    // Peer ids are the buyer's EVM address without 0x; channels store it with.
    const channels = store.getAllChannelsByBuyer('seller', `0x${buyerPeerId.replace(/^0x/, '').toLowerCase()}`, CHANNEL_KIND.PAID)
    // An active channel may carry the time of a partial settle; it still covers later requests.
    const channel = channels.find((entry) => entry.reservedAt <= at && (entry.status === 'active' || entry.settledAt === null || entry.settledAt >= at))
    return channel ? channelView(channel) : null
  } finally {
    store.close()
  }
}

function channelView(channel: StoredChannel): NonNullable<SellerLogDetail['channel']> {
  return {
    id: channel.sessionId,
    oneOff: channel.channelKind === CHANNEL_KIND.ONE_OFF,
    status: channel.status,
    openedAt: channel.reservedAt,
    settledAt: channel.settledAt,
    authorizedUsd: usd(channel.authMax),
    deliveredUsd: usd(channel.tokensDelivered),
    settledUsd: channel.settledAmount === null ? null : usd(channel.settledAmount),
    requests: channel.requestCount,
  }
}
