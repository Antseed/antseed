/**
 * ANTS staking inside the console. The console renders the staking dashboard's
 * own pages; this module serves the dashboard's API to them at
 * `/console/api/workspaces/:id/ants/*`, behind the console's sign-in and roles.
 *
 * The dashboard API keeps per-session state (the connected wallet, the one
 * pending wallet approval, the job journal), so each console session gets its
 * own dashboard session per workspace, bound to the workspace's buyer account.
 * Sessions close when idle. Every transaction is signed by the member's own
 * wallet in the browser; the gateway never signs for staking.
 */
import { createAntsServer, resolveAntsChain, AntsContext, type AntsChainConfig, type AntsServer } from '@antseed/ants'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { ZeroAddress } from 'ethers'
import { errorMessage } from '../../errors.js'
import { audit, requireWorkspaceAccess } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, respond, type ConsoleRequest, type ConsoleRouter } from '../router.js'
import { resolveIdentityAddress, type BuyerAddressBook } from '../../services/wallet-address.js'

/** A session nobody has called for this long is closed (unless a transaction is still running). */
const IDLE_MS = 30 * 60_000
/** More open sessions than this close the least recently used idle ones first. */
const MAX_SESSIONS = 64
const SWEEP_MS = 60_000

/** Dashboard actions that start a wallet transaction; recorded in the audit log. */
const ACTION_PATHS = new Set([
  'positions/stake', 'positions/move', 'positions/split', 'positions/merge', 'positions/extend', 'positions/max-lock', 'positions/withdraw',
  'rewards/claim', 'rewards/restake', 'rewards/stake-usage', 'rewards/compound',
  'verification/submit', 'seller/register', 'seller/claim-starter',
])

interface Session {
  server: Promise<AntsServer>
  lastUsed: number
}

/** Seams for tests; production uses the defaults. */
export interface StakingRouteOverrides {
  requireWorkspaceAccess?: typeof requireWorkspaceAccess
  buyerAddresses?: BuyerAddressBook
  resolveChain?: () => Promise<AntsChainConfig>
  /** The workspace buyer's address; defaults to the running buyer's identity book. */
  workspaceAddress?: (buyerIdentity: string) => Promise<string | null>
  createServer?: typeof createAntsServer
  now?: () => number
}

export function registerStakingRoutes(router: ConsoleRouter, deps: ConsoleDeps, overrides: StakingRouteOverrides = {}): void {
  const access = overrides.requireWorkspaceAccess ?? requireWorkspaceAccess
  const createServer = overrides.createServer ?? createAntsServer
  const now = overrides.now ?? deps.now
  const addressBook = overrides.buyerAddresses ?? deps.buyerAddresses ?? null
  const sessions = new Map<string, Session>()

  // Rank the chain's RPC endpoints once per process; every session reads in that order.
  let ranked: Promise<AntsChainConfig> | null = null
  const chain = (): Promise<AntsChainConfig> => {
    ranked ??= (async () => {
      const resolved = await (overrides.resolveChain ?? (() => resolveAntsChain(deps.configPath)))()
      const probe = new AntsContext({ chain: resolved, address: ZeroAddress })
      await probe.selectRpc()
      return probe.chain
    })()
    ranked.catch(() => { ranked = null })
    return ranked
  }

  const workspaceAddress = overrides.workspaceAddress ?? (async (buyerIdentity: string) =>
    (await resolveIdentityAddress(deps.dataDir, addressBook, buyerIdentity).catch(() => null))?.address ?? null)

  const close = (key: string, session: Session) => {
    sessions.delete(key)
    void session.server.then((server) => server.close()).catch(() => {})
  }

  /** Close idle sessions, then the least recently used idle ones while over the cap. Busy sessions stay. */
  const sweep = async () => {
    const entries = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    let open = entries.length
    for (const [key, session] of entries) {
      const server = await session.server.catch(() => null)
      if (!server) { close(key, session); open--; continue }
      if (server.busy) continue
      if (now() - session.lastUsed > IDLE_MS || open > MAX_SESSIONS) { close(key, session); open-- }
    }
  }
  const timer = setInterval(() => { void sweep() }, SWEEP_MS)
  timer.unref?.()

  const sessionFor = async (request: ConsoleRequest): Promise<AntsServer> => {
    const principal = request.principal
    if (principal?.kind !== 'member') throw new ConsoleError(403, 'forbidden', 'Staking needs a signed-in member.')
    const workspaceId = request.params['id'] ?? ''
    // Staking reads the workspace's buyer rewards, which the Rewards page also limits to admins.
    access(deps.store, principal, workspaceId, 'admin')
    const workspace = deps.store.getWorkspace(workspaceId)
    if (!workspace) throw new ConsoleError(404, 'not_found', 'Workspace not found.')
    const key = `${principal.sessionId}:${workspaceId}`
    let session = sessions.get(key)
    if (!session) {
      const buyerIdentity = workspace.buyerIdentity || DEFAULT_BUYER_IDENTITY
      const server = (async () => {
        const address = await workspaceAddress(buyerIdentity)
        if (!address) throw new ConsoleError(409, 'wallet_unavailable', 'This workspace has no wallet address yet.')
        return createServer({
          port: 0,
          browserWallet: true,
          serveWeb: false,
          selectRpc: false,
          chain: await chain(),
          address,
          dataDir: deps.dataDir,
          configPath: deps.configPath,
          stateKey: `console-${principal.memberId}-${workspaceId}`,
        })
      })()
      session = { server, lastUsed: now() }
      sessions.set(key, session)
      server.catch(() => { if (sessions.get(key) === session) sessions.delete(key) })
      if (sessions.size > MAX_SESSIONS) void sweep()
    }
    session.lastUsed = now()
    return session.server
  }

  const forward = async (request: ConsoleRequest) => {
    const server = await sessionFor(request)
    const rest = request.params['*'] ?? ''
    const query = request.query.toString()
    const response = await server.app.inject({
      method: request.method === 'POST' ? 'POST' : 'GET',
      url: `/api/${rest}${query ? `?${query}` : ''}`,
      headers: { authorization: `Bearer ${server.token}`, ...(request.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(request.method === 'POST' ? { payload: JSON.stringify(request.body ?? {}) } : {}),
    })
    let body: unknown
    try {
      body = response.json()
    } catch {
      deps.log(`console staking: ${request.method} ${rest} answered ${response.statusCode} without JSON`)
      throw new ConsoleError(502, 'staking_unavailable', 'The staking service did not answer.')
    }
    if (request.method === 'POST' && ACTION_PATHS.has(rest) && response.statusCode < 300) {
      const job = (body as { data?: { id?: string } } | null)?.data
      audit(deps, request, `staking.${rest.replace('/', '.')}`, { kind: 'workspace', id: request.params['id'] ?? null, label: null }, { jobId: job?.id ?? null })
    }
    // The dashboard's own `{ ok, data | error | state }` envelope, unchanged.
    return respond(response.statusCode, body)
  }

  const handle = async (request: ConsoleRequest) => {
    try {
      return await forward(request)
    } catch (error) {
      if (error instanceof ConsoleError) throw error
      deps.log(`console staking: ${request.method} ${request.params['*'] ?? ''}: ${errorMessage(error)}`)
      throw new ConsoleError(502, 'staking_unavailable', `Staking could not be loaded: ${errorMessage(error)}`)
    }
  }

  router.add('GET', '/workspaces/:id/ants/*', handle, { allow: ['member'] })
  router.add('POST', '/workspaces/:id/ants/*', handle, { allow: ['member'] })
}
