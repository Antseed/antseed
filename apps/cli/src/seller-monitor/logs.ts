import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MeteringStorage, type MeteringEventPageRow } from '@antseed/node/metering'
import { ChannelStore } from '@antseed/node/payments'
import type { SellerLogDetail, SellerLogEntry, SellerLogPage, SellerLogQuery } from '../gateway/console-api/types.js'

export const DEFAULT_LOG_PAGE = 50

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
  const metering = new MeteringStorage(path)
  try {
    const before = decodeCursor(query.cursor)
    const rows = metering.listEventsPage({
      limit: limit + 1,
      ...(before ? { before } : {}),
      ...(query.from ? { fromMs: query.from } : {}),
      ...(query.buyer ? { buyerPeerId: query.buyer.trim().toLowerCase().replace(/^0x/, '') } : {}),
      ...(query.service ? { service: query.service.trim() } : {}),
      ...(query.errorsOnly ? { errorsOnly: true } : {}),
    })
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      entries: page.map(toEntry),
      next: rows.length > limit && last ? `${last.timestamp}.${last.rowid}` : null,
    }
  } finally {
    metering.close()
  }
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
  const metering = new MeteringStorage(path)
  let row: ReturnType<MeteringStorage['getEventDetail']>
  try {
    row = metering.getEventDetail(id)
  } finally {
    metering.close()
  }
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
    channel: channelAt(dataDir, row.buyer_peer_id, row.timestamp),
  }
}

/** The seller-side channel with this buyer that was open when the request ran (newest first). */
function channelAt(dataDir: string, buyerPeerId: string, at: number): SellerLogDetail['channel'] {
  if (!existsSync(join(dataDir, 'payments', 'sessions.db'))) return null
  const store = new ChannelStore(join(dataDir, 'payments'))
  try {
    // Peer ids are the buyer's EVM address without 0x; channels store it with.
    const channels = store.getAllChannelsByBuyer('seller', `0x${buyerPeerId.replace(/^0x/, '').toLowerCase()}`)
    // An active channel may carry the time of a partial settle; it still covers later requests.
    const channel = channels.find((entry) => entry.reservedAt <= at && (entry.status === 'active' || entry.settledAt === null || entry.settledAt >= at))
    if (!channel) return null
    return {
      id: channel.sessionId,
      status: channel.status,
      openedAt: channel.reservedAt,
      settledAt: channel.settledAt,
      authorizedUsd: usd(channel.authMax),
      deliveredUsd: usd(channel.tokensDelivered),
      settledUsd: channel.settledAmount === null ? null : usd(channel.settledAmount),
      requests: channel.requestCount,
    }
  } finally {
    store.close()
  }
}
