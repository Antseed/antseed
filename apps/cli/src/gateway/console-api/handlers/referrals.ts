/**
 * Referrals (per workspace wallet) and the builders program (gateway-wide);
 * rules in `services/referrals.ts`. Reads come from the chain's explorer
 * and are cached briefly; claims are sent from the browser.
 */
import { resolveAntsChain, type AntsChainConfig, type AntsContext } from '@antseed/ants'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { ZeroAddress, type AbstractSigner } from 'ethers'
import { loadBuyerSigningIdentity } from '../../../buyer-identities/store.js'
import { ChainReadCache } from '../../../proxy/chain-read-cache.js'
import { errorMessage } from '../../errors.js'
import {
  clearWorkspaceInvite,
  createWorkspaceInvite,
  readBuilders,
  readBuilderSettings,
  readReferrals,
  redeemWorkspaceInvite,
  referralStateDir,
  setBuilderAgent,
} from '../../services/referrals.js'
import { assertSignerMatchesBuyer, resolveIdentityAddress } from '../../services/wallet-address.js'
import type { WorkspaceRecord } from '../../store.js'
import { requestActor, requireOrgAdmin, requireWorkspaceAccess } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, type ConsoleRequest, type ConsoleRouter } from '../router.js'
import type { Builders, CreatedInvite, Referrals } from '../types.js'
import { defaultBuyerClient, type BuyerClient } from './network-buyer.js'
import { gatewayAntsContext } from './wallet-chain.js'
import { record } from './wallet-mapping.js'

/** Explorer data moves per settlement batch; a minute keeps page refreshes off Antscan. */
const REFERRALS_TTL_MS = 60_000
const BUILDERS_TTL_MS = 5 * 60_000

/** Seams for tests; production uses the defaults. */
export interface ReferralRouteOverrides {
  buyer?: BuyerClient
  resolveChain?: () => Promise<AntsChainConfig>
  /** The ANTS context for a wallet (its signer, when one is needed). */
  context?: (chain: AntsChainConfig, address: string, signer?: AbstractSigner) => AntsContext
  /** The identity's address as the running buyer pays; null when unknown. */
  walletAddress?: (buyerIdentity: string) => Promise<string | null>
  /** The identity's signing key; null when it has none on this gateway. */
  loadSigner?: (buyerIdentity: string) => Promise<AbstractSigner | null>
  env?: NodeJS.ProcessEnv
}

export function registerReferralRoutes(router: ConsoleRouter, deps: ConsoleDeps, overrides: ReferralRouteOverrides = {}): void {
  const buyer = overrides.buyer ?? defaultBuyerClient(deps)
  const resolveChain = overrides.resolveChain ?? (() => resolveAntsChain(deps.configPath))
  const context = overrides.context ?? ((chain, address, signer) => gatewayAntsContext({ chain, address, buyerAddress: address, ...(signer ? { signer } : {}) }))
  const addressBook = deps.buyerAddresses ?? null
  const walletAddress = overrides.walletAddress
    ?? (async (name: string) => (await resolveIdentityAddress(deps.dataDir, addressBook, name).catch(() => null))?.address ?? null)
  const loadSigner = overrides.loadSigner ?? (async (name: string) => {
    const wallet = (await loadBuyerSigningIdentity(deps.dataDir, name))?.wallet ?? null
    // Never sign with a key that is not the wallet the buyer pays from.
    if (wallet) await assertSignerMatchesBuyer(addressBook, name, wallet.address)
    return wallet
  })
  const cache = new ChainReadCache({ now: deps.now, errorRetryMs: 30_000 })

  const workspace = (request: ConsoleRequest): { record: WorkspaceRecord; buyerIdentity: string; stateDir: string } => {
    const id = request.params['id'] ?? ''
    requireWorkspaceAccess(deps.store, request.principal, id, 'admin')
    const found = deps.store.getWorkspace(id)
    if (!found) throw new ConsoleError(404, 'not_found', 'Workspace not found.')
    const buyerIdentity = found.buyerIdentity || DEFAULT_BUYER_IDENTITY
    return { record: found, buyerIdentity, stateDir: referralStateDir(deps.dataDir, buyerIdentity) }
  }

  const addressOf = async (buyerIdentity: string): Promise<string> => {
    const address = await walletAddress(buyerIdentity)
    if (!address) throw new ConsoleError(409, 'wallet_unavailable', 'This workspace has no wallet address yet.')
    return address
  }

  const signerOf = async (buyerIdentity: string): Promise<AbstractSigner> => {
    let signer: AbstractSigner | null
    try {
      signer = await loadSigner(buyerIdentity)
    } catch (err) {
      if (err instanceof ConsoleError) throw err
      throw new ConsoleError(409, 'wallet_unavailable', `The wallet's key cannot be read: ${errorMessage(err)}`)
    }
    if (!signer) throw new ConsoleError(409, 'wallet_unavailable', `Buyer identity "${buyerIdentity}" has no wallet key on this gateway.`)
    return signer
  }

  const referrals = async (stateDir: string, address: string, fresh = false): Promise<Referrals> => {
    const key = `referrals:${address.toLowerCase()}`
    if (fresh) cache.invalidate(key)
    try {
      const read = await cache.read(key, { ttlMs: REFERRALS_TTL_MS, staleWhileRevalidateMs: REFERRALS_TTL_MS },
        async () => readReferrals(context(await resolveChain(), address), stateDir))
      return read.value
    } catch (err) {
      throw new ConsoleError(502, 'referrals_unavailable', `Referrals could not be read: ${errorMessage(err)}`)
    }
  }

  router.add('GET', '/workspaces/:id/referrals', async (request): Promise<Referrals> => {
    const ws = workspace(request)
    return referrals(ws.stateDir, await addressOf(ws.buyerIdentity), request.query.get('fresh') === '1')
  })

  router.add('POST', '/workspaces/:id/referrals/invites', async (request): Promise<CreatedInvite> => {
    const ws = workspace(request)
    const signer = await signerOf(ws.buyerIdentity)
    const address = await signer.getAddress()
    const created = await createWorkspaceInvite(context(await resolveChain(), address, signer), ws.stateDir, requestActor(deps, request), deps, ws.record)
    cache.invalidate(`referrals:${address.toLowerCase()}`)
    return created
  })

  router.add('POST', '/workspaces/:id/referrals/redeem', async (request): Promise<Referrals> => {
    const ws = workspace(request)
    const address = await addressOf(ws.buyerIdentity)
    await redeemWorkspaceInvite(context(await resolveChain(), address), ws.stateDir, record(request.body)['invite'], requestActor(deps, request), deps, ws.record)
    return referrals(ws.stateDir, address, true)
  })

  router.add('DELETE', '/workspaces/:id/referrals/redeem', async (request): Promise<Referrals> => {
    const ws = workspace(request)
    const address = await addressOf(ws.buyerIdentity)
    await clearWorkspaceInvite(ws.stateDir, requestActor(deps, request), deps, ws.record)
    return referrals(ws.stateDir, address, true)
  })

  const builders = async (fresh = false): Promise<Builders> => {
    if (fresh) cache.invalidate('builders')
    try {
      const read = await cache.read('builders', { ttlMs: BUILDERS_TTL_MS, staleWhileRevalidateMs: BUILDERS_TTL_MS },
        async () => readBuilders(context(await resolveChain(), ZeroAddress), deps.configPath, overrides.env))
      return read.value
    } catch (err) {
      throw new ConsoleError(502, 'builders_unavailable', `The builders program could not be read: ${errorMessage(err)}`)
    }
  }

  router.add('GET', '/builders', async (request): Promise<Builders> => {
    requireOrgAdmin(request.principal, deps.store)
    return builders(request.query.get('fresh') === '1')
  })

  router.add('PUT', '/builders', async (request): Promise<Builders> => {
    requireOrgAdmin(request.principal, deps.store)
    const chain = await resolveChain()
    const { restartRequired } = await setBuilderAgent(deps, requestActor(deps, request), request.body, context(chain, ZeroAddress), buyer)
    // The agent is saved by now: an unreachable explorer only leaves its rewards unknown.
    const view = await builders(true).catch(() => readBuilderSettings(chain, deps.configPath, overrides.env))
    return restartRequired ? { ...view, restartRequired: true } : view
  })
}
