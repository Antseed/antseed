/**
 * Workspace wallets: balances, card funding links, the deposit watcher,
 * payment channels and buyer rewards, plus the chain the browser signs
 * operator actions (claim, withdraw, deposit) against.
 */
import { resolveAntsChain, type AntsChainConfig, type RewardsView } from '@antseed/ants'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import type { AbstractSigner } from 'ethers'
import { loadBuyerSigningIdentity } from '../../../buyer-identities/store.js'
import { ChainReadCache } from '../../../proxy/chain-read-cache.js'
import { memberWalletCredentials, sessionSignIn } from '../../auth/db.js'
import { errorMessage } from '../../errors.js'
import { audit, requireOrgAdmin, requireWorkspaceAccess } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, type ConsoleRequest, type ConsoleRouter } from '../router.js'
import type { WalletOwner } from '../../services/operator.js'
import { assertSignerMatchesBuyer, resolveIdentityAddress, syncWalletCache, type BuyerAddressBook } from '../../services/wallet-address.js'
import type { WorkspaceRecord } from '../../store.js'
import type { Channel, ChainInfo, DepositWatch, Rewards, Wallet } from '../types.js'
import { buyerJson, defaultBuyerClient, optionalBuyerJson, withIdentity, type BuyerClient } from './network-buyer.js'
import { antseedPayBaseUrl, buildCardLink, CARD_PROVIDERS, type CardProvider } from './wallet-card-link.js'
import { chainInfo, mapBalances, mapChannels, mapDepositWatch, mapRewards, record } from './wallet-mapping.js'
import { createRewardsReader, REWARDS_TTL_MS } from './wallet-chain.js'
import { registerOperatorRoutes } from './wallet-operator.js'

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
  readRewards?: (chain: AntsChainConfig, address: string) => Promise<RewardsView>
  payBaseUrl?: () => string
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
  const payBaseUrl = overrides.payBaseUrl ?? (() => antseedPayBaseUrl())
  const signInOf = overrides.sessionSignIn ?? ((sessionId: string) => sessionSignIn(deps.store.database, sessionId))
  const memberWallets = overrides.memberWallets ?? ((memberId: string) => memberWalletCredentials(deps.store.database, memberId))
  // One cache for the chain reads this router makes itself: rewards (`rewards:<address>`) and the operator (`operator:<address>`).
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
    return body ? mapDepositWatch(body, address) : { mode: 'off', status: 'buyer-unreachable', lastTxHash: null }
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
    return mapChannels(await buyerJson(buyer, withIdentity(`/_antseed/channels${all ? '?all=1' : ''}`, ws.buyerIdentity)))
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
