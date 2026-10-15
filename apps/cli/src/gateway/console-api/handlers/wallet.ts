/**
 * Workspace wallets: balances, card funding links, the deposit watcher,
 * payment channels and buyer rewards, plus the chain the browser signs
 * operator actions (claim, withdraw, deposit) against.
 */
import { resolveAntsChain, type AntsChainConfig, type RewardsView } from '@antseed/ants'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import type { AbstractSigner } from 'ethers'
import { createHash } from 'node:crypto'
import { loadBuyerSigningIdentity } from '../../../buyer-identities/store.js'
import { ChainReadCache } from '../../../proxy/chain-read-cache.js'
import { memberWalletCredentials, sessionSignIn } from '../../auth/db.js'
import { errorMessage } from '../../errors.js'
import { audit, auditActor, requireOrgAdmin, requireWorkspaceAccess } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, type ConsoleRequest, type ConsoleRouter } from '../router.js'
import type { WalletOwner } from '../../services/operator.js'
import { assertSignerMatchesBuyer, resolveIdentityAddress, syncWalletCache, type BuyerAddressBook } from '../../services/wallet-address.js'
import type { WorkspaceRecord } from '../../store.js'
import type { Channel, ChainInfo, DepositConfirmation, DepositWatch, Rewards, Wallet } from '../types.js'
import type { DepositRecord } from '../../store.js'
import { usdcToDecimalString } from '../../money.js'
import { verifyDeposit, type VerifiedDeposit } from '../../services/deposits.js'
import { buyerJson, defaultBuyerClient, optionalBuyerJson, withIdentity, type BuyerClient } from './network-buyer.js'
import { antseedPayBaseUrl, buildCardLink, CARD_PROVIDERS, type CardProvider } from './wallet-card-link.js'
import { applyChannelChainState, chainInfo, mapBalances, mapChannels, mapDepositWatch, mapRewards, record, type ChannelChainState } from './wallet-mapping.js'
import { createRewardsReader, gatewayChainProvider, readChannelStates as readChannelStatesOnChain, REWARDS_TTL_MS } from './wallet-chain.js'
import { registerOperatorRoutes } from './wallet-operator.js'

/** Channel states are re-read from the chain at most this often for the same set of channels. */
const CHANNELS_TTL_MS = 30_000
/** Rows the buyer still counts as open; the chain may say otherwise. */
const OPEN_CHANNEL_STATUSES = new Set(['active', 'open', 'closing', 'withdrawable'])
/** After a failed rewards read, the chain is not asked again for this long (the last value is served, marked stale). */
const REWARDS_ERROR_RETRY_MS = 30_000
/** One rewards reader per process: one ANTS context and provider per chain. */
const sharedRewardsReader = createRewardsReader()

export interface SigningWallet {
  address: string
  signMessage(message: string): Promise<string>
  /** EIP-712 signing (ethers wallets have it); needed for operator authorizations. */
  signTypedData?: AbstractSigner['signTypedData']
}

/** Seams for tests; production uses the defaults. */
export interface WalletRouteOverrides {
  buyer?: BuyerClient
  requireWorkspaceAccess?: typeof requireWorkspaceAccess
  /** The buyer identity's wallet, able to sign; null when it has no readable key. */
  loadWallet?: (name: string) => Promise<SigningWallet | null>
  /** The identity's address as the running buyer pays, without loading a signer; null when unknown. */
  walletAddress?: (name: string) => Promise<string | null>
  /** The running buyer's identity → address; defaults to `deps.buyerAddresses`. */
  buyerAddresses?: BuyerAddressBook
  resolveChain?: () => Promise<AntsChainConfig>
  /** Buyer rewards, with the legacy epochs a claim may name (`legacyEpochs`, empty when unknown). */
  readRewards?: (chain: AntsChainConfig, address: string) => Promise<RewardsView & { legacyEpochs?: number[] }>
  /** On-chain records of these channels (AntseedChannels); ids that could not be read are left out. */
  readChannelStates?: (chain: AntsChainConfig, channelIds: string[]) => Promise<Map<string, ChannelChainState>>
  payBaseUrl?: () => string
  /** A deposit to `wallet` as its transaction receipt shows it; null when the transaction credited no such deposit. */
  verifyDeposit?: (chain: AntsChainConfig, txHash: string, wallet: string) => Promise<VerifiedDeposit | null>
  /** The buyer's current AntseedDeposits operator nonce (live read). */
  operatorNonce?: (chain: AntsChainConfig, buyer: string) => Promise<bigint>
  /** The buyer's current AntseedDeposits operator, null when none (live read). */
  readOperator?: (chain: AntsChainConfig, buyer: string) => Promise<string | null>
  /** The member who signs in with a wallet address; defaults to auth's credentials table. */
  walletOwner?: (address: string) => WalletOwner | null
  /** When a console session's sign-in happened and with which credential; defaults to auth's session table. */
  sessionSignIn?: (sessionId: string) => { authenticatedAt: number; credentialId: string | null } | null
  /** A member's wallet credentials (lower-case addresses, when added) and credential count; defaults to auth's credentials table. */
  memberWallets?: (memberId: string) => { wallets: Array<{ id: string; address: string; createdAt: number }>; total: number }
}

interface WorkspaceWallet {
  buyerIdentity: string
  record: WorkspaceRecord
}

/** The same key the buyer loads for the identity (ANTSEED_IDENTITY_HEX for the default one, then the identity files). */
async function loadSigningWallet(dataDir: string, name: string): Promise<SigningWallet | null> {
  return (await loadBuyerSigningIdentity(dataDir, name))?.wallet ?? null
}

function rejectionReason(result: Record<string, unknown>): string {
  if (typeof result['reason'] === 'string') return result['reason']
  if (typeof result['code'] === 'string') return result['code']
  return 'no reason given'
}

export function registerWalletRoutes(router: ConsoleRouter, deps: ConsoleDeps, overrides: WalletRouteOverrides = {}): void {
  const buyer = overrides.buyer ?? defaultBuyerClient(deps)
  const access = overrides.requireWorkspaceAccess ?? requireWorkspaceAccess
  const addressBook = overrides.buyerAddresses ?? deps.buyerAddresses ?? null
  const loadKey = overrides.loadWallet ?? ((name: string) => loadSigningWallet(deps.dataDir, name))
  // Every signature goes through here: a key that is not the wallet the buyer pays from is refused.
  const loadWallet = async (name: string): Promise<SigningWallet | null> => {
    const wallet = await loadKey(name)
    if (wallet) await assertSignerMatchesBuyer(addressBook, name, wallet.address)
    return wallet
  }
  // Live first (the running buyer), then the key on disk; never the cached workspace column.
  const walletAddress = overrides.walletAddress ?? (async (name: string) => (await resolveIdentityAddress(deps.dataDir, addressBook, name)).address)
  const resolveChain = overrides.resolveChain ?? (() => resolveAntsChain(deps.configPath))
  const readRewards = overrides.readRewards ?? sharedRewardsReader
  const readChannelStates = overrides.readChannelStates ?? readChannelStatesOnChain
  const payBaseUrl = overrides.payBaseUrl ?? (() => antseedPayBaseUrl())
  const signInOf = overrides.sessionSignIn ?? ((sessionId: string) => sessionSignIn(deps.store.database, sessionId))
  const memberWallets = overrides.memberWallets ?? ((memberId: string) => memberWalletCredentials(deps.store.database, memberId))
  // One cache for the chain reads this router makes itself: rewards (`rewards:<address>`), the operator (`operator:<address>`) and channel states (`channels:<ids hash>`).
  const chainCache = new ChainReadCache({ now: deps.now, errorRetryMs: REWARDS_ERROR_RETRY_MS })

  const workspace = (request: ConsoleRequest, minRole: 'member' | 'admin' = 'member'): WorkspaceWallet => {
    const id = request.params['id'] ?? ''
    access(deps.store, request.principal, id, minRole)
    const found = deps.store.getWorkspace(id)
    if (!found) throw new ConsoleError(404, 'not_found', 'Workspace not found.')
    return { buyerIdentity: found.buyerIdentity || DEFAULT_BUYER_IDENTITY, record: found }
  }

  /** The buyer reported this address for the workspace: correct the display cache if it differs. */
  const noteLiveAddress = (ws: WorkspaceWallet, address: string): void => {
    syncWalletCache(deps.store, ws.record, { address, source: 'live' }, (message) => deps.log(`console: WARNING ${message}`))
  }

  const addressOf = async (ws: WorkspaceWallet): Promise<string | null> => {
    if (!overrides.walletAddress) {
      const resolved = await resolveIdentityAddress(deps.dataDir, addressBook, ws.buyerIdentity).catch(() => null)
      if (resolved?.address && resolved.source === 'live') noteLiveAddress(ws, resolved.address)
      return resolved?.address ?? null
    }
    return walletAddress(ws.buyerIdentity).catch(() => null)
  }

  /** The identity's signing wallet; a key that cannot be read is a 409. */
  const workspaceSigner = async (ws: WorkspaceWallet): Promise<SigningWallet | null> => {
    try {
      return await loadWallet(ws.buyerIdentity)
    } catch (err) {
      if (err instanceof ConsoleError) throw err
      throw new ConsoleError(409, 'wallet_unavailable', `The wallet's key cannot be read: ${errorMessage(err)}`)
    }
  }

  const depositStatus = async (ws: WorkspaceWallet, address: string | null): Promise<DepositWatch> => {
    // The identity param is ignored by buyers that expose only the default watcher.
    const body = await optionalBuyerJson(buyer, withIdentity('/_antseed/deposits/status', ws.buyerIdentity))
    return body ? mapDepositWatch(body, address) : { mode: 'off', status: 'buyer-unreachable', lastTxHash: null, event: null }
  }

  router.add('GET', '/workspaces/:id/wallet', async (request): Promise<Wallet> => {
    const ws = workspace(request)
    // `fresh=1` (after a transaction) asks the buyer to re-read the chain; it rate-limits that per wallet.
    const fresh = request.query.get('fresh') === '1'
    const raw = await buyerJson(buyer, withIdentity(`/_antseed/balances${fresh ? '?fresh=1' : ''}`, ws.buyerIdentity))
    const balances = mapBalances(raw)
    if (balances.address) noteLiveAddress(ws, balances.address)
    const address = balances.address || await addressOf(ws) || ''
    return {
      buyerIdentity: ws.buyerIdentity, ...balances, address, deposit: await depositStatus(ws, address || null),
      // Last known values: the chain is unreachable or rate limiting right now.
      ...(raw['stale'] === true ? { stale: true } : {}),
    }
  })

  router.add('POST', '/workspaces/:id/wallet/card-link', async (request): Promise<{ url: string }> => {
    const ws = workspace(request)
    const body = record(request.body)
    const provider = body['provider'] as CardProvider
    if (!CARD_PROVIDERS.includes(provider)) throw new ConsoleError(400, 'invalid_provider', 'provider must be "crossmint" or "stripe".')
    const wallet = await workspaceSigner(ws)
    if (!wallet) throw new ConsoleError(409, 'wallet_unavailable', `Buyer identity "${ws.buyerIdentity}" has no wallet key on this gateway.`)
    try {
      return { url: await buildCardLink({ baseUrl: payBaseUrl(), wallet, amountUsd: body['amountUsd'], provider }) }
    } catch (err) {
      throw new ConsoleError(400, 'invalid_amount', errorMessage(err))
    }
  })

  router.add('POST', '/workspaces/:id/wallet/watch', async (request): Promise<DepositWatch> => {
    const ws = workspace(request)
    const mode = record(request.body)['mode']
    if (mode !== 'active' && mode !== 'background') throw new ConsoleError(400, 'invalid_mode', 'mode must be "active" or "background".')
    const address = await addressOf(ws)
    // Only the watcher the buyer exposes can be driven; refuse rather than promote another wallet's.
    const current = await depositStatus(ws, address)
    if (current.status === 'not-watched') {
      throw new ConsoleError(409, 'watch_unavailable', 'The buyer exposes a deposit watcher for its default wallet only; this wallet is swept automatically in the background.')
    }
    const result = await buyerJson(buyer, '/_antseed/deposits/watch', { method: 'POST', body: { mode, identity: ws.buyerIdentity } })
    return mapDepositWatch({ watcher: true, status: result['status'] }, address)
  })

  // ── Deposit confirmations ──
  const verify = overrides.verifyDeposit ?? ((chain: AntsChainConfig, txHash: string, wallet: string) => verifyDeposit(
    gatewayChainProvider(chain) as unknown as Parameters<typeof verifyDeposit>[0],
    {
      depositsContractAddress: chain.depositsContractAddress ?? '',
      depositRelayAddress: (chain as AntsChainConfig & { depositRelayAddress?: string }).depositRelayAddress,
      usdcContractAddress: chain.usdcContractAddress ?? '',
    },
    txHash,
    wallet,
  ))
  const confirmation = (deposit: DepositRecord, ws: WorkspaceWallet): DepositConfirmation => ({
    txHash: deposit.txHash,
    reference: `DEP-${deposit.txHash.slice(2, 10).toUpperCase()}`,
    kind: deposit.kind,
    wallet: deposit.wallet,
    workspaceId: ws.record.id,
    workspaceName: ws.record.name,
    sent: usdcToDecimalString(deposit.creditedUsdc + deposit.feeUsdc),
    credited: usdcToDecimalString(deposit.creditedUsdc),
    fee: usdcToDecimalString(deposit.feeUsdc),
    blockNumber: deposit.blockNumber,
    time: deposit.blockTime,
    sources: deposit.sources.map((source) => ({ from: source.from, amount: usdcToDecimalString(source.amountUsdc), txHash: source.txHash, minted: /^0x0{40}$/i.test(source.from) })),
    approval: deposit.approval ? { by: deposit.approval.byLabel, at: deposit.approval.at, note: deposit.approval.note } : null,
  })
  /** Verifies and stores one deposit of this workspace's wallet; null when the transaction is not one. */
  const recordDeposit = async (ws: WorkspaceWallet, txHash: string): Promise<DepositRecord | null> => {
    const known = deps.store.getDeposit(txHash)
    if (known) return known.workspaceId === ws.record.id ? known : null
    const address = await addressOf(ws)
    if (!address) throw new ConsoleError(409, 'wallet_unavailable', 'This workspace has no wallet address yet.')
    const verified = await verify(await resolveChain(), txHash, address)
    if (!verified) return null
    return deps.store.insertDeposit({ ...verified, workspaceId: ws.record.id })
  }
  const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
  const depositOf = (ws: WorkspaceWallet, request: ConsoleRequest): DepositRecord => {
    const found = deps.store.getDeposit(request.params['tx'] ?? '')
    if (!found || found.workspaceId !== ws.record.id) throw new ConsoleError(404, 'not_found', 'Deposit not found.')
    return found
  }

  router.add('GET', '/workspaces/:id/deposits', async (request): Promise<DepositConfirmation[]> => {
    const ws = workspace(request, 'admin')
    // New deposits the buyer recorded are verified on-chain before they are listed (a few per request).
    const history = await optionalBuyerJson(buyer, withIdentity('/_antseed/deposits/history', ws.buyerIdentity))
    const recorded = Array.isArray(history?.['deposits']) ? history['deposits'] as Array<Record<string, unknown>> : []
    const fresh = recorded.map((entry) => String(entry['txHash'] ?? '')).filter((hash) => TX_HASH_RE.test(hash) && !deps.store.getDeposit(hash))
    for (const txHash of fresh.slice(0, 10)) {
      await recordDeposit(ws, txHash).catch((err: unknown) => deps.log(`console: deposit ${txHash} not verified yet: ${errorMessage(err)}`))
    }
    return deps.store.listDeposits(ws.record.id).map((deposit) => confirmation(deposit, ws))
  })

  router.add('POST', '/workspaces/:id/deposits', async (request): Promise<DepositConfirmation> => {
    const ws = workspace(request, 'admin')
    const txHash = String(record(request.body)['txHash'] ?? '').trim()
    if (!TX_HASH_RE.test(txHash)) throw new ConsoleError(400, 'invalid_tx_hash', 'Paste the deposit transaction hash (0x followed by 64 hex characters).')
    const deposit = await recordDeposit(ws, txHash)
    if (!deposit) throw new ConsoleError(404, 'not_a_deposit', `That transaction did not credit a deposit to the ${ws.record.name} wallet.`)
    audit(deps, request, 'deposit.add', { kind: 'workspace', id: ws.record.id, label: ws.record.name }, { txHash: deposit.txHash })
    return confirmation(deposit, ws)
  })

  router.add('PUT', '/workspaces/:id/deposits/:tx/approval', async (request): Promise<DepositConfirmation> => {
    const ws = workspace(request, 'admin')
    const deposit = depositOf(ws, request)
    const noteRaw = record(request.body)['note']
    const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim().slice(0, 500) : null
    const actor = auditActor(deps.store, request.principal)
    const member = request.principal?.kind === 'member' ? deps.store.getMember(request.principal.memberId) : null
    const byLabel = member ? (member.email ? `${member.label} (${member.email})` : member.label) : actor.label ?? actor.kind
    const updated = deps.store.setDepositApproval(deposit.txHash, { byId: actor.id, byLabel, note })!
    audit(deps, request, 'deposit.approve', { kind: 'workspace', id: ws.record.id, label: ws.record.name }, { txHash: deposit.txHash, ...(note ? { note } : {}) })
    return confirmation(updated, ws)
  })

  router.add('DELETE', '/workspaces/:id/deposits/:tx/approval', async (request): Promise<DepositConfirmation> => {
    const ws = workspace(request, 'admin')
    const deposit = depositOf(ws, request)
    const updated = deps.store.setDepositApproval(deposit.txHash, null)!
    audit(deps, request, 'deposit.unapprove', { kind: 'workspace', id: ws.record.id, label: ws.record.name }, { txHash: deposit.txHash })
    return confirmation(updated, ws)
  })

  registerOperatorRoutes(router, deps, {
    access,
    loadWallet,
    walletAddress,
    resolveChain,
    ...(overrides.operatorNonce ? { operatorNonce: overrides.operatorNonce } : {}),
    ...(overrides.readOperator ? { readOperator: overrides.readOperator } : {}),
    ...(overrides.walletOwner ? { walletOwner: overrides.walletOwner } : {}),
    sessionSignIn: signInOf,
    memberWallets,
    cache: chainCache,
    onOperatorChanged: (address, buyerIdentity) => {
      // Rewards carry the operator (their recipient); the buyer caches it with the balances for 5 min.
      chainCache.invalidate(`rewards:${address.toLowerCase()}`)
      void optionalBuyerJson(buyer, withIdentity('/_antseed/balances?fresh=1', buyerIdentity))
    },
  })

  router.add('GET', '/workspaces/:id/channels', async (request): Promise<Channel[]> => {
    const ws = workspace(request)
    const all = request.query.get('all') === '1'
    const channels = mapChannels(await buyerJson(buyer, withIdentity(`/_antseed/channels${all ? '?all=1' : ''}`, ws.buyerIdentity)))
    // The buyer's store can call a channel active long after a seller settled
    // it, and reports its configured maximum as the reserve; the chain decides both.
    const ids = channels.filter((channel) => OPEN_CHANNEL_STATUSES.has(channel.status)).map((channel) => channel.channelId).sort()
    let states = new Map<string, ChannelChainState>()
    // After a close request or withdrawal the browser asks for a re-read rather than wait out the cache.
    if (request.query.get('fresh') === '1') chainCache.invalidate('channels')
    if (ids.length > 0) {
      try {
        states = (await chainCache.read(`channels:${createHash('sha256').update(ids.join(',')).digest('hex')}`, { ttlMs: CHANNELS_TTL_MS },
          async () => readChannelStates(await resolveChain(), ids))).value
      } catch {
        // Unreadable chain: show what the buyer knows rather than nothing.
      }
    }
    const nowSeconds = Math.floor(deps.now() / 1000)
    const reconciled = channels.map((channel) => applyChannelChainState(channel, states.get(channel.channelId), nowSeconds))
    return all ? reconciled : reconciled.filter((channel) => OPEN_CHANNEL_STATUSES.has(channel.status))
  })

  router.add('POST', '/workspaces/:id/channels/close', async (request): Promise<{ ok: true }> => {
    requireOrgAdmin(request.principal, deps.store)
    const ws = workspace(request)
    const peerId = record(request.body)['peerId']
    if (typeof peerId !== 'string' || !/^(0x)?[0-9a-fA-F]{40}$/.test(peerId.trim())) {
      throw new ConsoleError(400, 'invalid_peer', 'peerId must be a 40-character hex peer id.')
    }
    const result = record((await buyerJson(buyer, '/_antseed/channels/close', {
      method: 'POST',
      body: { peerId: peerId.trim().toLowerCase().replace(/^0x/, ''), includeAuth: true, identity: ws.buyerIdentity },
    }))['result'])
    if (result['status'] === 'rejected') {
      throw new ConsoleError(409, 'close_rejected', `The seller declined to close the channel (${rejectionReason(result)}).`)
    }
    chainCache.invalidate('channels')
    audit(deps, request, 'channel.close', { kind: 'workspace', id: request.params['id'] ?? null, label: null }, { buyerIdentity: ws.buyerIdentity, peerId: peerId.trim() })
    return { ok: true }
  })

  router.add('GET', '/workspaces/:id/rewards', async (request): Promise<Rewards> => {
    const ws = workspace(request)
    let address = await addressOf(ws)
    if (!address) address = mapBalances(await buyerJson(buyer, withIdentity('/_antseed/balances', ws.buyerIdentity))).address
    if (!address) throw new ConsoleError(409, 'wallet_unavailable', 'This workspace has no wallet address yet.')
    const owner = address
    try {
      // Five-minute cache; a page visit within ten minutes is answered at once while it refreshes.
      const read = await chainCache.read(`rewards:${owner.toLowerCase()}`, { ttlMs: REWARDS_TTL_MS, staleWhileRevalidateMs: REWARDS_TTL_MS },
        async () => mapRewards(await readRewards(await resolveChain(), owner), owner))
      return read.stale ? { ...read.value, stale: true } : read.value
    } catch (err) {
      throw new ConsoleError(502, 'rewards_unavailable', `Rewards could not be read from the chain: ${errorMessage(err)}`)
    }
  })

  router.add('GET', '/chain', async (): Promise<ChainInfo> => chainInfo(await resolveChain()))
}
