/**
 * Purchase statements for a workspace: its billing details and a statement
 * per month of what it bought from which sellers (see services/statements).
 * A month's statement is a draft until a day after the month ends; the first
 * read after that, with billing details set, keeps it as issued, so its
 * purchases never change. Its money in is read again on every view (see
 * `statementFunding`). Registered by `registerWalletRoutes`.
 */
import type { AntsChainConfig } from '@antseed/ants'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { ChainReadCache } from '../../../proxy/chain-read-cache.js'
import { errorMessage } from '../../errors.js'
import { listNetworkPeers } from '../../services/network.js'
import {
  buildStatement, fetchSettlements, periodBounds, periodsSince,
  SETTLEMENTS_WAIT_MS, statementFunding, statementReference, STATEMENT_GRACE_MS, type SettlementRead,
} from '../../services/statements.js'
import type { BillingProfileRecord, WorkspaceRecord } from '../../store.js'
import { usdcToDecimalString } from '../../money.js'
import { audit, type requireWorkspaceAccess } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, type ConsoleRequest, type ConsoleRouter } from '../router.js'
import type { BillingProfile, PurchaseStatement, StatementSummary, StatementSupplier } from '../types.js'
import { buyerJson, withIdentity, type BuyerClient } from './network-buyer.js'
import { mapChannels, record } from './wallet-mapping.js'

export interface StatementRouteSeams {
  access: typeof requireWorkspaceAccess
  walletAddress: (name: string) => Promise<string | null>
  resolveChain: () => Promise<AntsChainConfig>
  buyer: BuyerClient
  /** Stores the workspace's deposits not stored yet (a batch per read); true when none is left to check. */
  syncDeposits: (ws: WorkspaceRecord) => Promise<boolean>
  /** Seams for tests; production reads the chain explorer and the buyer's peers. */
  fetchSettlements?: (explorerUrl: string, buyer: string, from: number, to: number) => Promise<SettlementRead>
  peers?: () => Promise<Map<string, { name: string | null; verificationLinks: StatementSupplier['verificationLinks'] }>>
  /** The peer each of the buyer identity's payment channels paid, by channel id. */
  channelPeers?: (identity: string) => Promise<Map<string, string>>
}

const SETTLEMENTS_TTL_MS = 5 * 60 * 1000
const PEERS_TTL_MS = 5 * 60 * 1000

function profileView(profile: BillingProfileRecord): BillingProfile {
  return {
    companyName: profile.companyName,
    address: profile.address,
    country: profile.country,
    vatNumber: profile.vatNumber,
    registrationNumber: profile.registrationNumber,
    notes: profile.notes,
    updatedAt: profile.updatedAt,
  }
}

function text(body: Record<string, unknown>, field: string, max: number, required: boolean): string | null {
  const value = body[field]
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    if (required) throw new ConsoleError(400, 'invalid_billing_profile', `${field} is required.`)
    return null
  }
  if (typeof value !== 'string') throw new ConsoleError(400, 'invalid_billing_profile', `${field} must be a string.`)
  if (value.trim().length > max) throw new ConsoleError(400, 'invalid_billing_profile', `${field} is longer than ${max} characters.`)
  return value.trim()
}

export function registerStatementRoutes(router: ConsoleRouter, deps: ConsoleDeps, seams: StatementRouteSeams): void {
  const settlementsOf = seams.fetchSettlements ?? ((url: string, buyer: string, from: number, to: number) => fetchSettlements(url, buyer, from, to))
  const peers = seams.peers ?? (async () => new Map((await listNetworkPeers(deps.store, seams.buyer, deps.now())).map((peer) => [
    peer.peerId.toLowerCase().replace(/^0x/, ''), { name: peer.displayName, verificationLinks: peer.verificationLinks },
  ])))
  const channelPeers = seams.channelPeers ?? (async (identity: string) => new Map(
    mapChannels(await buyerJson(seams.buyer, withIdentity('/_antseed/channels?all=1', identity)))
      .filter((channel) => channel.peerId)
      .map((channel) => [channel.channelId.toLowerCase(), channel.peerId.toLowerCase().replace(/^0x/, '')]),
  ))
  const cache = new ChainReadCache({ now: deps.now, errorRetryMs: 30_000 })

  const workspace = (request: ConsoleRequest) => {
    const id = request.params['id'] ?? ''
    seams.access(deps.store, request.principal, id, 'admin')
    const found = deps.store.getWorkspace(id)
    if (!found) throw new ConsoleError(404, 'not_found', 'Workspace not found.')
    return found
  }

  router.add('GET', '/workspaces/:id/billing-profile', async (request): Promise<BillingProfile | null> => {
    const profile = deps.store.getBillingProfile(workspace(request).id)
    return profile ? profileView(profile) : null
  })

  router.add('PUT', '/workspaces/:id/billing-profile', async (request): Promise<BillingProfile> => {
    const ws = workspace(request)
    const body = record(request.body)
    // Any company, anywhere: only lengths are checked, and every field is kept as entered.
    const saved = deps.store.setBillingProfile(ws.id, {
      companyName: text(body, 'companyName', 200, true)!,
      address: text(body, 'address', 500, true)!,
      country: text(body, 'country', 100, false) ?? '',
      vatNumber: text(body, 'vatNumber', 50, false),
      registrationNumber: text(body, 'registrationNumber', 50, false),
      notes: text(body, 'notes', 1000, false),
    })
    audit(deps, request, 'billing.update', { kind: 'workspace', id: ws.id, label: ws.name }, { companyName: saved.companyName, ...(saved.vatNumber ? { vatNumber: saved.vatNumber } : {}) })
    return profileView(saved)
  })

  router.add('DELETE', '/workspaces/:id/billing-profile', async (request): Promise<{ ok: true }> => {
    const ws = workspace(request)
    if (deps.store.deleteBillingProfile(ws.id)) audit(deps, request, 'billing.delete', { kind: 'workspace', id: ws.id, label: ws.name })
    return { ok: true }
  })

  router.add('GET', '/workspaces/:id/statements', async (request): Promise<StatementSummary[]> => {
    const ws = workspace(request)
    const issued = new Map(deps.store.listStatements(ws.id).map((entry) => [entry.period, entry]))
    const first = deps.store.firstSpendAt(ws.id)
    const periods = new Set([...(first === null ? [] : periodsSince(first, deps.now())), ...issued.keys()])
    return [...periods].sort().reverse().map((period) => {
      const kept = issued.get(period)
      if (kept) {
        const content = JSON.parse(kept.content) as PurchaseStatement
        return { period, status: 'final', reference: content.reference, purchases: content.total, issuedAt: kept.issuedAt }
      }
      const bounds = periodBounds(period)!
      const spent = deps.store.statementLines(ws.id, bounds.from, bounds.to).reduce((sum, line) => sum + line.spentUsdc, 0)
      return { period, status: 'open', reference: statementReference(period, ws.id), purchases: usdcToDecimalString(spent), issuedAt: null }
    })
  })

  router.add('GET', '/workspaces/:id/statements/:period', async (request): Promise<PurchaseStatement> => {
    const ws = workspace(request)
    const period = request.params['period'] ?? ''
    const bounds = periodBounds(period)
    if (!bounds) throw new ConsoleError(400, 'invalid_period', 'period must be a month, e.g. 2026-10.')
    const now = deps.now()
    if (bounds.from > now) throw new ConsoleError(404, 'not_found', 'That month has not started yet.')
    const synced = seams.syncDeposits(ws).catch((err: unknown) => { deps.log(`console: deposits not synced: ${errorMessage(err)}`); return false })
    const kept = deps.store.getStatement(ws.id, period)
    if (kept) {
      await synced
      return { ...JSON.parse(kept.content) as PurchaseStatement, funding: statementFunding(period, deps.store.listDeposits(ws.id), now) }
    }

    const chain = await seams.resolveChain()
    const explorerUrl = chain.explorerApiUrl?.trim() || null
    const identity = ws.buyerIdentity || DEFAULT_BUYER_IDENTITY
    const wallet = await seams.walletAddress(identity).catch(() => null)
    const [settlementsRead, channelsRead, peerMap] = await Promise.all([
      explorerUrl && wallet
        ? cache.read(`settlements:${wallet.toLowerCase()}:${period}`, { ttlMs: SETTLEMENTS_TTL_MS }, () => settlementsOf(explorerUrl, wallet, bounds.from, bounds.to))
          .catch((err: unknown) => { deps.log(`console: settlements not read from ${explorerUrl}: ${errorMessage(err)}`); return null })
        : Promise.resolve(null),
      // Settlements name the address paid; the buyer's channels name the peer, which differs for a delegated seller.
      explorerUrl && wallet
        ? cache.read(`channel-peers:${identity}`, { ttlMs: SETTLEMENTS_TTL_MS }, () => channelPeers(identity))
          .catch((err: unknown) => { deps.log(`console: payment channels not read: ${errorMessage(err)}`); return null })
        : Promise.resolve(null),
      cache.read('peers', { ttlMs: PEERS_TTL_MS }, peers).then((read) => read.value).catch(() => new Map()),
      synced,
    ])
    // The explorer answers from its index: its rows are this chain's only when it indexes this chain alone (the
    // settlements carry no chain), and settlements after its checkpoint are not listed yet.
    const indexed = settlementsRead?.value.indexed ?? []
    const onlyChain = indexed.length === 1 && indexed[0]!.chainId === chain.evmChainId ? indexed[0]! : null
    const explorerComplete = explorerUrl === null
      || (settlementsRead !== null && !settlementsRead.stale && onlyChain !== null && onlyChain.at >= bounds.to)
    // Without the buyer's channels a delegated seller's settlements could not be put with its purchases. They are
    // the gateway's own buyer's, so the week's wait for the explorer does not excuse them.
    const channelsKnown = explorerUrl === null || wallet === null || (channelsRead !== null && !channelsRead.stale)
    const settlementsComplete = explorerComplete && channelsKnown
    const buyer = deps.store.getBillingProfile(ws.id)
    // Final once the month is over (plus a day for late spend reports and settlements), the buyer is named, and
    // every outside read answered now (a value cached before a failed refresh is not enough) and covers the month,
    // except the explorer's after a week: then it is issued without settlements.
    const final = now >= bounds.to + STATEMENT_GRACE_MS && buyer !== null && channelsKnown
      && (explorerComplete || now >= bounds.to + SETTLEMENTS_WAIT_MS)
    // A list that may be incomplete or another chain's is never shown as the payments, in a draft or a final statement.
    const settlements = settlementsComplete ? settlementsRead?.value.settlements ?? null : null
    const statement = buildStatement({
      period,
      workspace: { id: ws.id, name: ws.name, wallet },
      buyer,
      lines: deps.store.statementLines(ws.id, bounds.from, bounds.to),
      deposits: deps.store.listDeposits(ws.id),
      peers: peerMap,
      settlements,
      channelPeers: channelsRead?.value ?? new Map(),
      settlementsSource: settlements ? explorerUrl : null,
      // Any spend by another workspace up to the month's end: a settlement can pay for purchases of earlier months.
      sharedWallet: deps.store.workspacesSpendingFrom(ws.buyerIdentity || DEFAULT_BUYER_IDENTITY, 0, bounds.to)
        .filter((id) => id !== ws.id).length,
      status: final ? 'final' : 'open',
      now,
    })
    if (!final) return statement
    // Another request may have issued it meanwhile; the one kept first wins.
    const saved = deps.store.saveStatement(ws.id, period, now, JSON.stringify(statement))
    if (saved.issuedAt === now) audit(deps, request, 'statement.issue', { kind: 'workspace', id: ws.id, label: ws.name }, { period, reference: statement.reference })
    return { ...JSON.parse(saved.content) as PurchaseStatement, funding: statement.funding }
  })
}
