/**
 * Purchase statements: a month of a workspace's paid requests, per seller and
 * model, with the settlement transactions that paid each seller and the money
 * that came in. Built from the gateway's own ledger; the one outside read is the
 * chain explorer's index of settlements (one query, paged), so a statement
 * costs no RPC calls. Amounts are in USDC.
 *
 * It is a record of purchases, not an invoice: each seller is paid directly
 * from the workspace's credits and issues none.
 */
import { usdcToDecimalString } from '../money.js'
import type { BillingProfileRecord, DepositRecord, StatementLineRow } from '../store.js'
import type { PurchaseStatement, StatementSupplier } from '../console-api/types.js'

type Fetch = typeof fetch

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/
const DAY_MS = 24 * 60 * 60 * 1000
/** A month's statement becomes final this long after the month ends: late spend reports and settlements are in by then. */
export const STATEMENT_GRACE_MS = DAY_MS
/**
 * When the chain explorer still cannot list a month's settlements this long after it ends, the statement is
 * issued without them (marked as not read) rather than staying a draft: the purchases are the gateway's own record.
 */
export const SETTLEMENTS_WAIT_MS = 7 * DAY_MS
const OUTSIDE_TIMEOUT_MS = 10_000
/** Settlements read per explorer page, and at most this many pages (50,000 settlements) per statement. */
const SETTLEMENT_PAGE = 1000
const SETTLEMENT_PAGES = 50

/** [from, to) of a "YYYY-MM" month in UTC; null when malformed. */
export function periodBounds(period: string): { from: number; to: number } | null {
  const match = PERIOD_RE.exec(period)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  return { from: Date.UTC(year, month, 1), to: Date.UTC(year, month + 1, 1) }
}

export function periodOf(epochMs: number): string {
  const date = new Date(epochMs)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Every month from `first` up to the one containing `now`, newest first (at most `limit`). */
export function periodsSince(first: number, now: number, limit = 36): string[] {
  const periods: string[] = []
  let cursor = periodOf(now)
  const last = periodOf(first)
  while (periods.length < limit) {
    periods.push(cursor)
    if (cursor <= last) break
    const bounds = periodBounds(cursor)!
    cursor = periodOf(bounds.from - 1)
  }
  return periods
}

/** "PS-2026-10-1A2B3C": the month and the workspace, so the same month of two workspaces never share one. */
export function statementReference(period: string, workspaceId: string): string {
  const code = workspaceId.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase()
  return `PS-${period}-${code}`
}

async function fetchWithTimeout(fetchImpl: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(OUTSIDE_TIMEOUT_MS) })
}

export interface Settlement {
  seller: string
  /** The payment channel it settled; null when the explorer did not say. */
  channelId: string | null
  txHash: string
  /** Epoch ms. */
  time: number
  amountUsdc: number
}

export interface SettlementRead {
  settlements: Settlement[]
  /** How far the explorer has indexed each chain (block time, epoch ms): settlements after that are not listed yet. */
  indexed: Array<{ chainId: number; at: number }>
}

/**
 * Settlements that paid sellers from `buyer`'s credits in [from, to), from
 * the explorer's GraphQL index (Antscan), one row per seller and transaction,
 * with how far the explorer had indexed when it answered.
 */
export async function fetchSettlements(explorerUrl: string, buyer: string, from: number, to: number, fetchImpl: Fetch = fetch): Promise<SettlementRead> {
  const merged = new Map<string, Settlement>()
  let indexed: SettlementRead['indexed'] = []
  let after: string | null = null
  for (let page = 0; page < SETTLEMENT_PAGES; page += 1) {
    // The checkpoint is read with the first page, so nothing indexed after it is taken for complete.
    const query = `query ($buyer: String!, $from: Int!, $to: Int!, $after: String) {
      ${after === null ? '_meta { status }' : ''}
      settlementServices(where: { buyer: $buyer, timestamp_gte: $from, timestamp_lt: $to, deltaAmountUsdc_gt: "0" },
        orderBy: "timestamp", orderDirection: "asc", limit: ${SETTLEMENT_PAGE}, after: $after) {
        items { txHash seller channelId deltaAmountUsdc timestamp }
        pageInfo { hasNextPage endCursor }
      }
    }`
    const variables = { buyer: buyer.toLowerCase(), from: Math.floor(from / 1000), to: Math.ceil(to / 1000), after }
    const response = await fetchWithTimeout(fetchImpl, `${explorerUrl.replace(/\/$/, '')}/graphql`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }),
    })
    if (!response.ok) throw new Error(`explorer: HTTP ${response.status}`)
    const body = await response.json() as {
      data?: { _meta?: { status?: Record<string, { id?: unknown; block?: { timestamp?: unknown } }> }; settlementServices?: { items?: Array<Record<string, unknown>>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } }
      errors?: Array<{ message?: string }>
    }
    const result = body.data?.settlementServices
    if (!result) throw new Error(`explorer: ${body.errors?.[0]?.message ?? 'no settlements in the answer'}`)
    if (after === null) {
      indexed = Object.values(body.data?._meta?.status ?? {})
        .map((chain) => ({ chainId: Number(chain?.id), at: Number(chain?.block?.timestamp) * 1000 }))
        .filter((chain) => Number.isSafeInteger(chain.chainId) && Number.isFinite(chain.at))
    }
    for (const item of result.items ?? []) {
      const seller = String(item['seller'] ?? '').toLowerCase()
      const txHash = String(item['txHash'] ?? '').toLowerCase()
      const amount = Number(item['deltaAmountUsdc'] ?? 0)
      if (!seller || !txHash || !Number.isSafeInteger(amount)) continue
      // A settlement is split per service; one row per seller and transaction.
      const key = `${seller}:${txHash}`
      const known = merged.get(key)
      if (known) known.amountUsdc += amount
      else merged.set(key, { seller, channelId: String(item['channelId'] ?? '').toLowerCase() || null, txHash, time: Number(item['timestamp'] ?? 0) * 1000, amountUsdc: amount })
    }
    if (!result.pageInfo?.hasNextPage || !result.pageInfo.endCursor) return { settlements: [...merged.values()], indexed }
    after = result.pageInfo.endCursor
  }
  throw new Error('explorer: too many settlements to list')
}

const peerKey = (peerId: string): string => peerId.trim().toLowerCase().replace(/^0x/, '')

export interface StatementInput {
  period: string
  workspace: { id: string; name: string; wallet: string | null }
  buyer: BillingProfileRecord | null
  lines: StatementLineRow[]
  deposits: DepositRecord[]
  /** Seller names and proven claims, by peer id. */
  peers: ReadonlyMap<string, { name: string | null; verificationLinks: StatementSupplier['verificationLinks'] }>
  settlements: Settlement[] | null
  /**
   * The buyer's own payment channels: the peer each one paid, by channel id. A delegated seller is paid at its
   * seller contract while its purchases are under its peer id; its settlements are listed under that peer.
   */
  channelPeers: ReadonlyMap<string, string>
  settlementsSource: string | null
  /** How many other workspaces paid from the same wallet by the month's end. */
  sharedWallet: number
  status: PurchaseStatement['status']
  now: number
}

/** The statement document from the month's ledger lines, deposits and settlements. */
export function buildStatement(input: StatementInput): PurchaseStatement {
  const bounds = periodBounds(input.period)!
  const bySeller = new Map<string, StatementLineRow[]>()
  for (const line of input.lines) {
    const key = peerKey(line.sellerPeerId ?? '')
    bySeller.set(key, [...(bySeller.get(key) ?? []), line])
  }
  // The peer the buyer paid on the settled channel; the address paid when the buyer has no record of the channel.
  const supplierOf = (settlement: Settlement): string =>
    (settlement.channelId ? input.channelPeers.get(settlement.channelId) : undefined) ?? peerKey(settlement.seller)
  // A seller paid this month for what was bought before is listed too, with no purchases, so its settlement is on the record.
  // Not with a shared wallet: that seller may have sold only to another workspace.
  for (const settlement of input.sharedWallet ? [] : input.settlements ?? []) {
    const key = supplierOf(settlement)
    if (!bySeller.has(key)) bySeller.set(key, [])
  }
  const suppliers: StatementSupplier[] = [...bySeller].map(([key, lines]) => {
    const peer = input.peers.get(key)
    const settlements = input.settlements
      ?.filter((settlement) => supplierOf(settlement) === key)
      .sort((a, b) => a.time - b.time)
      .map((settlement) => ({ txHash: settlement.txHash, time: settlement.time, amount: usdcToDecimalString(settlement.amountUsdc) })) ?? null
    return {
      peerId: key ? `0x${key}` : '',
      name: peer?.name ?? null,
      verificationLinks: peer?.verificationLinks ?? [],
      lines: lines
        .sort((a, b) => Number(a.routingFee) - Number(b.routingFee) || b.spentUsdc - a.spentUsdc)
        .map((line) => ({
          service: line.model,
          kind: line.routingFee ? 'routing' as const : 'inference' as const,
          requests: line.requests,
          inputTokens: line.inputTokens,
          cachedInputTokens: line.cachedInputTokens,
          outputTokens: line.outputTokens,
          amount: usdcToDecimalString(line.spentUsdc),
        })),
      total: usdcToDecimalString(lines.reduce((sum, line) => sum + line.spentUsdc, 0)),
      settlements,
    }
  }).sort((a, b) => Number(b.total) - Number(a.total))

  const total = input.lines.reduce((sum, line) => sum + line.spentUsdc, 0)
  return {
    period: input.period,
    from: bounds.from,
    to: bounds.to,
    status: input.status,
    reference: statementReference(input.period, input.workspace.id),
    issuedAt: input.status === 'final' ? input.now : null,
    generatedAt: input.now,
    workspace: input.workspace,
    buyer: input.buyer ? {
      companyName: input.buyer.companyName,
      address: input.buyer.address,
      country: input.buyer.country,
      vatNumber: input.buyer.vatNumber,
      registrationNumber: input.buyer.registrationNumber,
      notes: input.buyer.notes,
      updatedAt: input.buyer.updatedAt,
    } : null,
    suppliers,
    total: usdcToDecimalString(total),
    requests: input.lines.filter((line) => !line.routingFee).reduce((sum, line) => sum + line.requests, 0),
    funding: statementFunding(input.period, input.deposits, input.now),
    settlementsSource: input.settlementsSource,
    sharedWallet: input.sharedWallet,
  }
}

/**
 * The money that came in during the month, as the gateway has recorded it
 * now: transfers to the wallet and direct deposits (sweeps move it into the
 * credits; their fee is the relay fee). Not kept with a final statement but
 * read again each time, since a transfer can be recorded only once it is
 * swept, after the month.
 */
export function statementFunding(period: string, deposits: DepositRecord[], now: number): PurchaseStatement['funding'] {
  const bounds = periodBounds(period)!
  const inPeriod = deposits.filter((deposit) => deposit.blockTime >= bounds.from && deposit.blockTime < bounds.to)
  const incoming = inPeriod.filter((deposit) => deposit.kind !== 'relay').sort((a, b) => a.blockTime - b.blockTime)
  return {
    deposits: incoming.map((deposit) => ({
      txHash: deposit.txHash,
      reference: `DEP-${deposit.txHash.slice(2, 10).toUpperCase()}`,
      kind: deposit.kind,
      time: deposit.blockTime,
      amount: usdcToDecimalString(deposit.creditedUsdc + deposit.feeUsdc),
    })),
    total: usdcToDecimalString(incoming.reduce((sum, deposit) => sum + deposit.creditedUsdc + deposit.feeUsdc, 0)),
    relayFees: usdcToDecimalString(inPeriod.filter((deposit) => deposit.kind === 'relay').reduce((sum, deposit) => sum + deposit.feeUsdc, 0)),
    asOf: now,
  }
}

