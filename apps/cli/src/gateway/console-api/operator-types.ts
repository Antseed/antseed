/**
 * Wire types of the workspace "authorized wallet" (AntseedDeposits operator)
 * routes. Kept apart from types.ts so the console can import them type-only.
 *
 * GET  /workspaces/:id/wallet/operator?fresh=1  → OperatorState   (any workspace member; fresh=1 re-reads the chain, throttled)
 * POST /workspaces/:id/wallet/operator/sync     { txHash? } → OperatorState  (re-reads the chain after a browser transaction; audits a change)
 * POST /workspaces/:id/wallet/operator-auth     { operator } → OperatorAuthorization  (see types.ts)
 *
 * Contract rules (AntseedDeposits):
 *   - setOperator(buyer, operator, nonce, buyerSig): only while no operator is
 *     set (else OperatorAlreadySet); `nonce` must equal getOperatorNonce(buyer)
 *     (else InvalidNonce); the buyer key signs; anyone may submit and pay gas.
 *   - transferOperator(buyer, newOperator): only the current operator; no
 *     buyer signature. newOperator may be the zero address, which clears it.
 *   - withdraw(buyer, amount): only the operator; USDC goes to the operator.
 *   - AntseedUsageRewards.claimBuyerReward(buyer, epoch): only the operator,
 *     who receives the ANTS.
 */

/**
 * The current operator relative to whoever is asking:
 * - `none`: not set; an org owner can authorize one of their wallets.
 * - `self`: the workspace wallet is its own operator (`antseed buyer set-authorized-wallet --self`).
 * - `yours`: one of the caller's own sign-in wallets.
 * - `member`: a sign-in wallet of another member of this gateway.
 * - `unknown`: an address no member signs in with.
 */
export type OperatorRelation = 'none' | 'self' | 'yours' | 'member' | 'unknown'

export interface OperatorState {
  /** The workspace wallet (the buyer in AntseedDeposits). */
  buyer: string
  operator: string | null
  relation: OperatorRelation
  /** Whose sign-in wallet the operator is, for `member`; org owners and admins only, else null. */
  memberLabel: string | null
  /** The caller may start a new authorization (org owner signed in to the console, no operator set). */
  canAuthorize: boolean
  /**
   * The caller's own sign-in wallets and when each may become the operator
   * (24 h after it was added). Only for org owners; empty otherwise.
   */
  eligibleWallets: Array<{ address: string; eligibleAt: number }>
  /** When the operator was last read from the chain (ms). */
  checkedAt: number
}

/** `OperatorAuth` plus what the browser needs to submit it safely. */
export interface OperatorAuthorization {
  buyer: string
  nonce: string
  signature: string
  operator?: string
  /** The AntseedDeposits address and EVM chain id the signature is bound to. */
  depositsContract?: string
  chainId?: number
}
