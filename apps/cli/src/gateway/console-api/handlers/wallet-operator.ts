/**
 * The workspace wallet's authorized wallet (AntseedDeposits operator):
 * reading it, re-reading it after a browser transaction, and the owner-only
 * SetOperator authorization. Registered by `registerWalletRoutes`.
 */
import type { AntsChainConfig } from '@antseed/ants'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { FRESH_SIGN_IN_MS, OPERATOR_WALLET_MIN_AGE_MS } from '../../auth/db.js'
import { errorMessage } from '../../errors.js'
import type { ChainReadCache } from '../../../proxy/chain-read-cache.js'
import {
  depositsOperatorReader,
  normalizeOperator,
  OperatorCache,
  operatorRelation,
  signOperatorAuthorization,
  walletOwnerFromDb,
  type OperatorReader,
  type TypedDataSigner,
  type WalletOwner,
} from '../../services/operator.js'
import { audit, isOrgAdmin, type requireWorkspaceAccess } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import type { OperatorAuthorization, OperatorState } from '../operator-types.js'
import { ConsoleError, type ConsoleRequest, type ConsoleRouter } from '../router.js'
import { record } from './wallet-mapping.js'

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

export interface OperatorRouteSeams {
  access: typeof requireWorkspaceAccess
  loadWallet: (name: string) => Promise<TypedDataSigner | null>
  walletAddress: (name: string) => Promise<string | null>
  resolveChain: () => Promise<AntsChainConfig>
  /** Live nonce read; defaults to AntseedDeposits on the chain. */
  operatorNonce?: (chain: AntsChainConfig, buyer: string) => Promise<bigint>
  /** Live operator read (null when none); defaults to AntseedDeposits on the chain. */
  readOperator?: (chain: AntsChainConfig, buyer: string) => Promise<string | null>
  sessionSignIn: (sessionId: string) => { authenticatedAt: number; credentialId: string | null } | null
  memberWallets: (memberId: string) => { wallets: Array<{ id: string; address: string; createdAt: number }>; total: number }
  /** The member who signs in with a wallet address; defaults to auth's credentials table. */
  walletOwner?: (address: string) => WalletOwner | null
  /** The gateway's shared chain-read cache (operator entries live under `operator:<address>`). */
  cache?: ChainReadCache
  /** A sync saw the operator change: drop what depends on it (rewards, the buyer's cached balances). */
  onOperatorChanged?: (buyer: string, buyerIdentity: string) => void
}

export function registerOperatorRoutes(router: ConsoleRouter, deps: ConsoleDeps, seams: OperatorRouteSeams): void {
  const cache = new OperatorCache(deps.now, undefined, undefined, seams.cache)
  const readerFor = (chain: AntsChainConfig): OperatorReader => {
    let fallback: OperatorReader | null = null
    const chainReader = (): OperatorReader => (fallback ??= depositsOperatorReader(chain))
    return {
      operator: async (buyer) => seams.readOperator ? normalizeOperator(await seams.readOperator(chain, buyer)) : chainReader().operator(buyer),
      nonce: (buyer) => seams.operatorNonce ? seams.operatorNonce(chain, buyer) : chainReader().nonce(buyer),
    }
  }
  const ownerOf = seams.walletOwner ?? ((address: string) => walletOwnerFromDb(deps.store.database, (id) => deps.store.getMember(id), address))

  const workspace = (request: ConsoleRequest, minRole: 'member' | 'admin' = 'member') => {
    const id = request.params['id'] ?? ''
    seams.access(deps.store, request.principal, id, minRole)
    const found = deps.store.getWorkspace(id)
    if (!found) throw new ConsoleError(404, 'not_found', 'Workspace not found.')
    return { id, buyerIdentity: found.buyerIdentity || DEFAULT_BUYER_IDENTITY }
  }

  // The address the running buyer pays from (seams.walletAddress is live-first); the cached workspace column is display-only.
  const buyerAddress = async (ws: { buyerIdentity: string }): Promise<string> => {
    const address = await seams.walletAddress(ws.buyerIdentity).catch(() => null)
    if (!address) throw new ConsoleError(409, 'wallet_unavailable', 'This workspace has no wallet address yet.')
    return address
  }

  const readOperator = async (buyer: string, fresh: boolean) => {
    try {
      const chain = await seams.resolveChain()
      return await cache.read(buyer, () => readerFor(chain).operator(buyer), fresh)
    } catch (err) {
      if (err instanceof ConsoleError) throw err
      throw new ConsoleError(502, 'chain_unavailable', `The authorized wallet could not be read from the chain: ${errorMessage(err)}`)
    }
  }

  const describe = (request: ConsoleRequest, buyer: string, read: { operator: string | null; checkedAt: number }): OperatorState => {
    const { principal } = request
    const viewer = principal?.kind === 'member' ? deps.store.getMember(principal.memberId) : null
    const { relation, owner } = operatorRelation({ buyer, operator: read.operator, viewerMemberId: viewer?.id ?? null, ownerOf })
    const isOwner = viewer?.status === 'active' && viewer.orgRole === 'owner'
    return {
      buyer,
      operator: read.operator,
      relation,
      memberLabel: relation === 'member' && owner && isOrgAdmin(deps.store, principal) ? owner.label : null,
      canAuthorize: isOwner && relation === 'none',
      eligibleWallets: isOwner && viewer
        ? seams.memberWallets(viewer.id).wallets.map((entry) => ({ address: entry.address, eligibleAt: entry.createdAt + OPERATOR_WALLET_MIN_AGE_MS }))
        : [],
      checkedAt: read.checkedAt,
    }
  }

  router.add('GET', '/workspaces/:id/wallet/operator', async (request): Promise<OperatorState> => {
    const ws = workspace(request)
    const buyer = await buyerAddress(ws)
    return describe(request, buyer, await readOperator(buyer, request.query.get('fresh') === '1'))
  })

  // After the browser confirms a setOperator / transferOperator transaction it
  // asks for a re-read. The chain is the source of truth, never the client:
  // a change is audited with what the chain says, plus the reported hash.
  router.add('POST', '/workspaces/:id/wallet/operator/sync', async (request): Promise<OperatorState> => {
    const ws = workspace(request)
    const buyer = await buyerAddress(ws)
    const sent = record(request.body)['txHash']
    const txHash = typeof sent === 'string' && TX_HASH_RE.test(sent) ? sent : null
    const before = cache.known(buyer)
    const read = await readOperator(buyer, true)
    if (before && (before.operator?.toLowerCase() ?? null) !== (read.operator?.toLowerCase() ?? null)) {
      deps.log(`console: SECURITY authorized wallet of workspace ${ws.id} (${buyer}) changed: ${before.operator ?? 'none'} → ${read.operator ?? 'none'}`)
      seams.onOperatorChanged?.(buyer, ws.buyerIdentity)
      audit(deps, request, 'wallet.operator.changed', { kind: 'workspace', id: ws.id, label: null }, {
        buyerIdentity: ws.buyerIdentity, buyer, before: before.operator, after: read.operator, txHash,
      })
    }
    return describe(request, buyer, read)
  })

  // The workspace wallet signs AntseedDeposits' SetOperator authorization
  // (as apps/payments' POST /api/operator/sign does); the operator's own
  // wallet then submits it from the browser and pays the gas. The operator
  // can withdraw everything the wallet holds, so this is the most sensitive
  // action in the console: only an org owner, signed in within the last
  // five minutes with a passkey/wallet session (not a token, key or
  // Cloudflare Access), and only for a wallet the owner has proven as one of
  // their own sign-in methods at least OPERATOR_WALLET_MIN_AGE_MS ago. When
  // the owner has another sign-in method, the fresh sign-in must be with it,
  // not with the operator wallet itself. A stale session gets 403
  // `reauth_required`: confirm through /auth/reauth/* and retry. The current
  // operator and nonce are read live right before signing; a wallet that
  // already has an operator gets 409 `operator_already_set`.
  router.add('POST', '/workspaces/:id/wallet/operator-auth', async (request): Promise<OperatorAuthorization> => {
    const { principal } = request
    const workspaceId = request.params['id'] ?? ''
    const deny = (status: number, code: string, message: string, details: Record<string, unknown> = {}): ConsoleError => {
      deps.log(`console: SECURITY operator authorization for workspace ${workspaceId} refused (${code})`)
      audit(deps, request, 'wallet.operator_auth.denied', { kind: 'workspace', id: workspaceId, label: null }, { code, ...details })
      return new ConsoleError(status, code, message, code === 'wallet_mismatch' ? details : undefined)
    }
    if (principal?.kind !== 'member') throw deny(403, 'forbidden', 'Only the organization owner, signed in to the console, can authorize an operator.')
    const caller = deps.store.getMember(principal.memberId)
    if (!caller || caller.status !== 'active') throw new ConsoleError(401, 'unauthorized', 'Sign in to continue')
    if (caller.orgRole !== 'owner') throw deny(403, 'forbidden', 'Only the organization owner can authorize an operator.')
    const ws = workspace(request)
    const sent = record(request.body)['operator']
    const operator = typeof sent === 'string' ? sent.trim() : ''
    if (!/^0x[0-9a-fA-F]{40}$/.test(operator) || /^0x0{40}$/.test(operator)) {
      throw new ConsoleError(400, 'invalid_operator', 'operator must be a wallet address.')
    }
    const credentials = seams.memberWallets(caller.id)
    const operatorCredential = credentials.wallets.find((entry) => entry.address === operator.toLowerCase())
    if (!operatorCredential) {
      throw deny(403, 'operator_not_yours', 'The operator must be a wallet you sign in with. Add it under your sign-in methods first.', { operator })
    }
    const age = deps.now() - operatorCredential.createdAt
    if (age < OPERATOR_WALLET_MIN_AGE_MS) {
      const hours = Math.max(1, Math.ceil((OPERATOR_WALLET_MIN_AGE_MS - age) / 3_600_000))
      throw deny(403, 'operator_too_new', `This wallet was added as a sign-in method less than ${OPERATOR_WALLET_MIN_AGE_MS / 3_600_000} hours ago. For your safety it can become an operator only after that; try again in about ${hours} hour${hours === 1 ? '' : 's'}.`, { operator })
    }
    if (principal.sessionId.startsWith('cf-access:')) {
      throw deny(403, 'reauth_unavailable', 'You are signed in through Cloudflare Access, which cannot confirm this action. Sign in to the console with your passkey or wallet (add one under your sign-in methods if you have none), then retry.')
    }
    const signIn = seams.sessionSignIn(principal.sessionId)
    if (!signIn || signIn.credentialId === null || deps.now() - signIn.authenticatedAt > FRESH_SIGN_IN_MS) {
      throw deny(403, 'reauth_required', 'Sign in again (passkey or wallet) to confirm, then retry.')
    }
    if (credentials.total > 1 && signIn.credentialId === operatorCredential.id) {
      throw deny(403, 'reauth_other_credential', 'Confirm with a sign-in method other than the wallet you are making the operator (another passkey or wallet), then retry.', { operator })
    }
    let wallet: TypedDataSigner | null
    try {
      wallet = await seams.loadWallet(ws.buyerIdentity)
    } catch (err) {
      if (err instanceof ConsoleError && err.code === 'wallet_mismatch') {
        throw deny(409, 'wallet_mismatch', err.message, err.details)
      }
      throw new ConsoleError(409, 'wallet_unavailable', `The wallet's key cannot be read: ${errorMessage(err)}`)
    }
    if (!wallet || typeof wallet.signTypedData !== 'function') {
      throw new ConsoleError(409, 'wallet_unavailable', `Buyer identity "${ws.buyerIdentity}" has no wallet key on this gateway.`)
    }
    let chain: AntsChainConfig
    try {
      chain = await seams.resolveChain()
    } catch (err) {
      throw new ConsoleError(502, 'chain_unavailable', `The chain configuration could not be loaded: ${errorMessage(err)}`)
    }
    let auth: Awaited<ReturnType<typeof signOperatorAuthorization>>
    try {
      auth = await signOperatorAuthorization({ wallet, chain, operator, reader: readerFor(chain) })
    } catch (err) {
      if (err instanceof ConsoleError && err.code === 'operator_already_set') {
        throw deny(409, 'operator_already_set', err.message, { operator })
      }
      throw err
    }
    deps.log(`console: SECURITY operator authorization signed: workspace ${workspaceId} wallet ${wallet.address} → operator ${auth.operator} (nonce ${auth.nonce}) by owner ${caller.id}`)
    audit(deps, request, 'wallet.operator_auth', { kind: 'workspace', id: workspaceId, label: null }, {
      buyerIdentity: ws.buyerIdentity, buyer: wallet.address, operator, nonce: auth.nonce,
    })
    const { nonceValue: _nonceValue, ...body } = auth
    return body
  })
}
