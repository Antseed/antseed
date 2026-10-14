/**
 * The workspace's authorized wallet (AntseedDeposits operator): its API,
 * the panel's state machine and transaction error copy. Contract rules are
 * documented with the wire types (cli/src/gateway/console-api/operator-types.ts).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import type { OperatorAuthorization, OperatorRelation, OperatorState, WorkspaceOperatorSummary } from '../api/types'
import { isSetAddress, sameAddress } from './chain'
import { formatDateTime, shortId } from './format'
import { qk } from './queries'

export type { OperatorAuthorization, OperatorRelation, OperatorState, WorkspaceOperatorSummary }

export const operatorKey = (workspaceId: string) => ['wallet-operator', workspaceId] as const

export const operatorApi = {
  /** `fresh` re-reads the chain (the gateway throttles it to one read every few seconds). */
  get: (workspaceId: string, fresh = false) => api.wallet.operator(workspaceId, fresh),
  /** Re-read after a confirmed transaction; the gateway audits a change the chain confirms. */
  sync: (workspaceId: string, txHash?: string | null) => api.wallet.operatorSync(workspaceId, txHash),
  authorize: (workspaceId: string, operator: string) => api.wallet.operatorAuth(workspaceId, operator),
}

/** The authorized wallet as the gateway last read it (cached there for a minute). */
export function useOperator(workspaceId: string, enabled = true) {
  return useQuery({ queryKey: operatorKey(workspaceId), queryFn: () => operatorApi.get(workspaceId), staleTime: 30_000, enabled })
}

/** Authorized-wallet status of every workspace the viewer can open, for markers (the gateway caches each read for a minute). */
export function useWorkspaceOperators(enabled = true) {
  return useQuery({ queryKey: qk.operators, queryFn: () => api.wallet.operators(), staleTime: 60_000, enabled })
}

/** True when the summary says the workspace has no authorized wallet (unknown reads are not flagged). */
export function lacksOperator(summary: Pick<WorkspaceOperatorSummary, 'relation'> | null | undefined): boolean {
  return summary?.relation === 'none'
}

/** After the authorized wallet changes (or may have): store the re-read state and refresh what depends on it. */
export function useOperatorRefresh(workspaceId: string) {
  const queryClient = useQueryClient()
  const apply = (state: OperatorState) => {
    queryClient.setQueryData(operatorKey(workspaceId), state)
    void queryClient.invalidateQueries({ queryKey: qk.operators })
    void queryClient.invalidateQueries({ queryKey: qk.wallet(workspaceId) })
    void queryClient.invalidateQueries({ queryKey: qk.rewards(workspaceId) })
  }
  return {
    apply,
    /** Re-read from the chain (the gateway throttles it). */
    refresh: async () => apply(await operatorApi.get(workspaceId, true)),
  }
}

export type OperatorTone = 'info' | 'success' | 'warning' | 'danger'

export interface OperatorView {
  tone: OperatorTone
  /** Short badge text for the relation. */
  badge: string
  title: string
  /** One short line shown with the wallet. */
  summary: string
  /** The full explanation; shown behind "What does this mean?" when it says more than `summary`. */
  body: string
  /** Show the authorize flow (owner, none set). */
  canAuthorize: boolean
  /** The connected wallet is the operator: it may transfer or clear. */
  canManage: boolean
  /** What to do to manage it, when `canManage` is false and someone could. */
  manageHint: string | null
  /** Nobody here signs in with it: whoever controls it can link it to their account (add it as a sign-in wallet). */
  canLink: boolean
}

/**
 * The panel for each state:
 *   none     → owner: authorize one of their wallets; others: read only.
 *   self     → the gateway-held wallet is its own operator; hand it over from the CLI.
 *   yours    → connect it to transfer or clear.
 *   member   → that member connects it to transfer or clear.
 *   unknown  → danger: only that address can change it.
 */
export function operatorView(state: OperatorState, connected: string | null | undefined): OperatorView {
  const operator = state.operator
  const short = shortId(operator)
  const isOperator = isSetAddress(operator) && sameAddress(connected, operator)
  const manage = (who: string): Pick<OperatorView, 'canManage' | 'manageHint'> => (isOperator
    ? { canManage: true, manageHint: null }
    : { canManage: false, manageHint: `Only ${who} can transfer or remove it: connect ${short} to do so.` })
  switch (state.relation) {
    case 'none':
      return {
        tone: 'warning',
        badge: 'Not set',
        title: 'No authorized wallet',
        summary: state.canAuthorize
          ? 'Authorize one of your wallets to withdraw funds and claim ANTS rewards. Requests keep working meanwhile.'
          : 'Nobody can withdraw funds or claim ANTS rewards until the organization owner authorizes a wallet.',
        body: state.canAuthorize
          ? 'Nobody can withdraw this workspace\'s funds or claim its ANTS rewards until you authorize one of your wallets. Requests keep working meanwhile.'
          : 'Nobody can withdraw this workspace\'s funds or claim its ANTS rewards until one is authorized. Only the organization owner can authorize a wallet; requests keep working meanwhile.',
        canAuthorize: state.canAuthorize,
        canManage: false,
        manageHint: null,
        canLink: false,
      }
    case 'self':
      return {
        tone: 'info',
        badge: 'Workspace wallet',
        title: 'The workspace wallet authorizes itself',
        summary: 'Withdrawals and rewards stay in the wallet the gateway holds.',
        body: 'Withdrawals and rewards stay in the wallet the gateway holds. To hand the role to a personal wallet, run `antseed gateway workspace operator transfer <workspace> <address>` on the gateway host (the workspace wallet pays the gas).',
        canAuthorize: false,
        canManage: false,
        manageHint: null,
        canLink: false,
      }
    case 'yours':
      return {
        tone: 'success',
        badge: 'Your wallet',
        title: `Your wallet ${short}`,
        summary: 'Withdrawals and ANTS rewards go to this wallet, and only it can transfer or remove the role.',
        body: 'Withdrawals and ANTS rewards go to this wallet, and only it can transfer or remove the role.',
        canAuthorize: false,
        canLink: false,
        ...manage('this wallet'),
      }
    case 'member': {
      const who = state.memberLabel ? `${state.memberLabel}'s wallet` : 'Another member\'s wallet'
      return {
        tone: 'info',
        badge: state.memberLabel ? state.memberLabel : 'Member',
        title: `${who} ${short}`,
        summary: 'Withdrawals and ANTS rewards go to this wallet, and only it can transfer or remove the role.',
        body: 'Withdrawals and ANTS rewards go to this wallet, and only it can transfer or remove the role.',
        canAuthorize: false,
        canLink: false,
        ...manage(state.memberLabel ? `${state.memberLabel}'s wallet` : 'that member\'s wallet'),
      }
    }
    // Usually a wallet someone here controls but has not added as a console sign-in method:
    // say so calmly, offer to link it, and keep the warning for the details.
    case 'unknown':
      return {
        tone: 'info',
        badge: 'Not linked to a console member',
        title: `Authorized wallet ${short}`,
        summary: 'Withdrawals and ANTS rewards go to this wallet. If it is yours, link it to your account to manage it here.',
        body: 'No member of this gateway signs in with this address, yet withdrawals and ANTS rewards go to it, and only it can transfer or remove the role: not the gateway, not the organization owner. If nobody on your team controls it, do not add more than you plan to spend (the gateway can still spend the balance on requests, but it cannot be withdrawn). Ask whoever controls it to transfer the role, or move to a new workspace with a fresh wallet.',
        canAuthorize: false,
        canLink: true,
        ...manage('that wallet'),
      }
  }
}

export interface Gate {
  ok: boolean
  /** Why the action is unavailable, or null when it is. */
  reason: string | null
  /** The wallet the user must connect, when one exists. */
  operator: string | null
}

/**
 * Withdrawals (USDC) and reward claims (ANTS) are sent to the operator and
 * must be signed by it. `verb` is "withdraw" or "claim rewards".
 */
export function operatorGate(state: OperatorState | null | undefined, connected: string | null | undefined, verb: string): Gate {
  if (!state) return { ok: false, reason: 'Checking the authorized wallet…', operator: null }
  const operator = isSetAddress(state.operator) ? state.operator : null
  if (!operator) {
    return {
      ok: false,
      operator: null,
      reason: `Only the authorized wallet can ${verb}, and none is set. ${state.canAuthorize ? 'Authorize one of your wallets under Authorized wallet.' : 'Ask the organization owner to authorize one.'}`,
    }
  }
  if (state.relation === 'self') {
    return { ok: false, operator, reason: `This workspace's authorized wallet is the gateway-held wallet itself, so a browser wallet cannot ${verb}. Use the antseed CLI on the gateway host, or transfer the role to a personal wallet.` }
  }
  if (!connected) return { ok: false, operator, reason: `Connect the authorized wallet ${shortId(operator)} to ${verb}. Funds go to that wallet.` }
  if (!sameAddress(connected, operator)) {
    return { ok: false, operator, reason: `The connected wallet ${shortId(connected)} is not the authorized wallet ${shortId(operator)}. Switch to ${shortId(operator)} in your wallet to ${verb}.` }
  }
  return { ok: true, operator, reason: null }
}

export interface EligibleWallet {
  address: string
  eligibleAt: number
  ready: boolean
}

/** The owner's sign-in wallets with whether each can be authorized now (24 h after it was added). */
export function eligibleWallets(state: OperatorState, now = Date.now()): EligibleWallet[] {
  return state.eligibleWallets.map((entry) => ({ ...entry, ready: entry.eligibleAt <= now }))
}

/** Why the connected wallet cannot be authorized, or null when it can. */
export function authorizeBlocker(state: OperatorState, connected: string | null | undefined, now = Date.now()): string | null {
  if (!state.canAuthorize) return state.relation === 'none' ? 'Only the organization owner can authorize a wallet.' : 'A wallet is already authorized; only it can transfer the role.'
  if (!connected) return 'Connect the wallet you want to authorize.'
  const match = state.eligibleWallets.find((entry) => sameAddress(entry.address, connected))
  if (!match) return `${shortId(connected)} is not one of your sign-in methods. Add it under Your sign-in methods first; it can be authorized 24 hours later.`
  if (match.eligibleAt > now) return `${shortId(connected)} was added as a sign-in method recently. For your safety it can be authorized from ${formatDateTime(match.eligibleAt)}.`
  return null
}

const REVERT_COPY: Record<string, { message: string; refresh: boolean }> = {
  OperatorAlreadySet: { message: 'Another wallet was authorized in the meantime. The panel now shows the current authorized wallet.', refresh: true },
  InvalidNonce: { message: 'The authorization expired: the operator nonce changed on chain. Start again to get a fresh authorization.', refresh: true },
  InvalidSignature: { message: 'The contract rejected the gateway\'s signature. The gateway and your wallet may be on different chains or deposits contracts.', refresh: false },
  NotAuthorized: { message: 'The connected wallet is not (or no longer) the authorized wallet. The panel now shows the current one.', refresh: true },
  NotRewardRecipient: { message: 'Only the authorized wallet can claim. The panel now shows the current one.', refresh: true },
  RewardRecipientUnavailable: { message: 'No authorized wallet is set, so rewards cannot be claimed yet.', refresh: true },
  InsufficientBalance: { message: 'Not enough available balance; funds reserved in open channels cannot be withdrawn.', refresh: true },
  InvalidAddress: { message: 'The contract rejected the address.', refresh: false },
  ChannelNotActive: { message: 'This channel is already settled or closed; nothing is left to do. The list now shows it.', refresh: true },
  CloseAlreadyRequested: { message: 'A close was already requested for this channel. The list now shows when the reserve can be withdrawn.', refresh: true },
  CloseNotReady: { message: 'The 15-minute grace period has not ended yet. Withdraw once the countdown reaches zero.', refresh: true },
}

/** The custom error name in a viem/wagmi error chain, e.g. "OperatorAlreadySet". */
export function revertErrorName(error: unknown): string | null {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const data = (current as { data?: { errorName?: unknown } }).data
    if (data && typeof data.errorName === 'string') return data.errorName
    current = (current as { cause?: unknown }).cause
  }
  const text = error instanceof Error ? `${error.message} ${(error as { shortMessage?: string }).shortMessage ?? ''}` : String(error ?? '')
  return Object.keys(REVERT_COPY).find((name) => text.includes(name)) ?? null
}

/** Copy for a failed operator, withdraw or claim transaction, and whether the shown state is now stale. */
export function operatorTxError(error: unknown): { message: string; refresh: boolean } | null {
  const name = revertErrorName(error)
  return name ? REVERT_COPY[name] ?? null : null
}

export class OperatorPreflightError extends Error {
  constructor(message: string, readonly refresh: boolean, readonly retryAuth = false) {
    super(message)
    this.name = 'OperatorPreflightError'
  }
}

/**
 * Checks a signed authorization against the chain just before submitting:
 * still no operator, same nonce, same contract and chain. A changed nonce
 * means a fresh authorization is needed (`retryAuth`).
 */
export function checkAuthorization(
  auth: OperatorAuthorization,
  live: { operator: string | null; nonce: bigint },
  expected: { depositsContract: string | null; chainId: number; operator: string },
): void {
  if (auth.chainId !== undefined && auth.chainId !== expected.chainId) {
    throw new OperatorPreflightError(`The gateway signed for chain ${auth.chainId} but the console is set up for chain ${expected.chainId}.`, false)
  }
  if (auth.depositsContract && expected.depositsContract && !sameAddress(auth.depositsContract, expected.depositsContract)) {
    throw new OperatorPreflightError('The gateway signed for a different deposits contract than the one the console reports. Reload the page.', false)
  }
  if (auth.operator && !sameAddress(auth.operator, expected.operator)) {
    throw new OperatorPreflightError(`The authorization is for ${shortId(auth.operator)}, not ${shortId(expected.operator)}.`, false)
  }
  if (isSetAddress(live.operator)) {
    throw new OperatorPreflightError(`An authorized wallet is already set (${shortId(live.operator)}). The panel now shows it.`, true)
  }
  if (live.nonce.toString() !== auth.nonce) {
    throw new OperatorPreflightError('The operator nonce changed since the gateway signed. Getting a fresh authorization…', true, true)
  }
}

/** The relation as the mock computes it; mirrors services/operator.ts `operatorRelation`. */
export function relationFor(
  operator: string | null,
  buyer: string,
  viewerMemberId: string | null,
  wallets: Array<{ memberId: string; label: string; address: string }>,
): { relation: OperatorRelation; memberLabel: string | null } {
  if (!isSetAddress(operator)) return { relation: 'none', memberLabel: null }
  if (sameAddress(operator, buyer)) return { relation: 'self', memberLabel: null }
  const owner = wallets.find((entry) => sameAddress(entry.address, operator))
  if (!owner) return { relation: 'unknown', memberLabel: null }
  return owner.memberId === viewerMemberId ? { relation: 'yours', memberLabel: null } : { relation: 'member', memberLabel: owner.label }
}
