/**
 * Staked free tier for a workspace: the stakers whose seller-pool stake counts
 * toward the workspace buyer's free-tier allowance. Codes are saved in the
 * gateway config (`buyer.freeTierDelegations`); the running buyer reloads it
 * within a minute and sends each identity only its own delegations.
 * Registered by `registerWalletRoutes`.
 */
import { readFile } from 'node:fs/promises'
import { AntsContext, freeTierStake, type AntsChainConfig } from '@antseed/ants'
import { ZeroAddress } from 'ethers'
import {
  DEFAULT_BUYER_IDENTITY,
  acceptFreeTierDelegationCode,
  verifyFreeTierDelegations,
  withFreeTierDelegation,
  type FreeTierDelegation,
} from '@antseed/node'
import { updateFreeTierDelegations } from '../../../config/free-tier-delegations.js'
import { audit, type requireWorkspaceAccess } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import type { FreeTierSharing, FreeTierStake } from '../free-tier-types.js'
import { ConsoleError, type ConsoleRequest, type ConsoleRouter } from '../router.js'
import { asObject, requiredString } from '../serialize.js'

export interface FreeTierRouteSeams {
  access: typeof requireWorkspaceAccess
  walletAddress: (name: string) => Promise<string | null>
  resolveChain: () => Promise<AntsChainConfig>
  /** Reads the counted stake on `chain`; defaults to a live chain read. */
  readStake?: (chain: AntsChainConfig, buyer: string, stakers: Array<{ staker: string; expiresAt: number }>) => Promise<Omit<FreeTierStake, 'buyer'>>
}

/** Stake changes at most once a week; the panel can lag it by a minute. */
const STAKE_TTL_MS = 60_000

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function registerFreeTierRoutes(router: ConsoleRouter, deps: ConsoleDeps, seams: FreeTierRouteSeams): void {
  const workspace = async (request: ConsoleRequest, minRole: 'member' | 'admin') => {
    const id = request.params['id'] ?? ''
    seams.access(deps.store, request.principal, id, minRole)
    const found = deps.store.getWorkspace(id)
    if (!found) throw new ConsoleError(404, 'not_found', 'Workspace not found.')
    const buyer = await seams.walletAddress(found.buyerIdentity || DEFAULT_BUYER_IDENTITY).catch(() => null)
    if (!buyer) throw new ConsoleError(409, 'wallet_unavailable', 'This workspace has no wallet address yet.')
    return { record: found, buyer }
  }

  const readDelegations = async (): Promise<FreeTierDelegation[]> => {
    let raw: string
    try {
      raw = await readFile(deps.configPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const buyer = (JSON.parse(raw) as { buyer?: { freeTierDelegations?: unknown } }).buyer
    return Array.isArray(buyer?.freeTierDelegations) ? buyer.freeTierDelegations as FreeTierDelegation[] : []
  }

  const writeDelegations = (mutate: (current: FreeTierDelegation[]) => FreeTierDelegation[]) =>
    updateFreeTierDelegations(deps.configPath, mutate)

  const sharing = async (buyer: string): Promise<FreeTierSharing> => {
    const now = deps.now()
    const stakers = (await readDelegations())
      .filter((delegation) => sameAddress(delegation.buyer, buyer))
      .map((delegation) => ({ staker: delegation.staker, expiresAt: delegation.expiresAt, expired: delegation.expiresAt * 1000 <= now }))
    return { buyer, stakers }
  }

  router.add('GET', '/workspaces/:id/free-tier', async (request): Promise<FreeTierSharing> => {
    const ws = await workspace(request, 'member')
    return sharing(ws.buyer)
  })

  // One chain context for the current chain settings, its endpoints ranked once.
  // Settings can change while the gateway runs (RPC URLs in Settings), so each
  // read resolves them and a changed fingerprint gets a fresh context.
  let context: { key: string; ctx: Promise<AntsContext> } | null = null
  const chainContext = (chain: AntsChainConfig, key: string) => {
    if (context?.key !== key) {
      const entry = {
        key,
        ctx: (async () => {
          const ctx = new AntsContext({ chain, address: ZeroAddress })
          await ctx.selectRpc()
          return ctx
        })(),
      }
      entry.ctx.catch(() => { if (context === entry) context = null })
      context = entry
    }
    return context.ctx
  }
  const readStake = seams.readStake ?? (async (chain, buyer, stakers) => freeTierStake(await chainContext(chain, JSON.stringify(chain)), buyer, stakers))
  const stakeCache = new Map<string, { at: number; value: Promise<FreeTierStake> }>()

  router.add('GET', '/workspaces/:id/free-tier/stake', async (request): Promise<FreeTierStake> => {
    const ws = await workspace(request, 'member')
    const unavailable = (error: unknown) =>
      new ConsoleError(503, 'chain_unavailable', `Could not read stake from the chain: ${error instanceof Error ? error.message : String(error)}`)
    let chain: AntsChainConfig
    try {
      chain = await seams.resolveChain()
    } catch (error) {
      throw unavailable(error)
    }
    // Only codes sellers on this network accept: signed for its chain, for this buyer, not expired.
    // Filter to this buyer first: the verifier reads at most 8 entries, and other workspaces' codes share the file.
    const mine = (await readDelegations()).filter((delegation) => sameAddress(delegation.buyer, ws.buyer))
    const active = verifyFreeTierDelegations(mine, ws.buyer, chain.evmChainId, deps.now())
    const key = JSON.stringify([chain, ws.buyer.toLowerCase(), active])
    const cached = stakeCache.get(key)
    if (cached && deps.now() - cached.at < STAKE_TTL_MS) return cached.value
    const value = readStake(chain, ws.buyer, active).then((view) => ({ buyer: ws.buyer, ...view }))
    if (stakeCache.size >= 256) stakeCache.clear()
    stakeCache.set(key, { at: deps.now(), value })
    value.catch(() => { if (stakeCache.get(key)?.value === value) stakeCache.delete(key) })
    try {
      return await value
    } catch (error) {
      throw unavailable(error)
    }
  })

  router.add('POST', '/workspaces/:id/free-tier', async (request): Promise<FreeTierSharing> => {
    const ws = await workspace(request, 'admin')
    const code = requiredString(asObject(request.body), 'code', 1000)
    const chain = await seams.resolveChain()
    let delegation: FreeTierDelegation
    try {
      delegation = acceptFreeTierDelegationCode(code, ws.buyer, chain.evmChainId, deps.now())
    } catch (error) {
      throw new ConsoleError(400, 'invalid_code', error instanceof Error ? error.message : String(error))
    }
    try {
      await writeDelegations((current) => withFreeTierDelegation(current, delegation))
    } catch (error) {
      if (error instanceof ConsoleError) throw error
      throw new ConsoleError(409, 'too_many_stakers', error instanceof Error ? error.message : String(error))
    }
    audit(deps, request, 'free_tier.add', { kind: 'workspace', id: ws.record.id, label: ws.record.name }, { staker: delegation.staker, expiresAt: delegation.expiresAt })
    return sharing(ws.buyer)
  })

  router.add('DELETE', '/workspaces/:id/free-tier/:staker', async (request): Promise<FreeTierSharing> => {
    const ws = await workspace(request, 'admin')
    const staker = request.params['staker'] ?? ''
    await writeDelegations((current) => current.filter((delegation) => !(sameAddress(delegation.buyer, ws.buyer) && sameAddress(delegation.staker, staker))))
    audit(deps, request, 'free_tier.remove', { kind: 'workspace', id: ws.record.id, label: ws.record.name }, { staker })
    return sharing(ws.buyer)
  })
}
