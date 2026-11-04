/**
 * Epoch bookkeeping for the referral and builders claims (wallet/ReferralClaim.tsx).
 * The builders contract claims one epoch per transaction, so a run can stop
 * part way (the wallet rejects a later prompt): the epochs that confirmed
 * must not be sent again, or the retry's first simulation reverts with
 * AlreadyClaimed.
 */
import type { TxStep } from './tx-steps'

/** `epochs` without the ones already claimed, in order. */
export function unclaimedEpochs(epochs: readonly number[], claimed: ReadonlySet<number>): number[] {
  return epochs.filter((epoch) => !claimed.has(epoch))
}

/**
 * The epochs the chain already marks claimed: a claim confirmed in an
 * earlier attempt that the explorer has not indexed yet. A read that fails
 * counts as unclaimed; the pre-flight simulation still names AlreadyClaimed.
 */
export async function claimedOnChain(epochs: readonly number[], isClaimed: (epoch: number) => Promise<boolean>): Promise<number[]> {
  const claimed = await Promise.all(epochs.map((epoch) => isClaimed(epoch).catch(() => false)))
  return epochs.filter((_, index) => claimed[index])
}

export interface ClaimCalls {
  label: (epochs: readonly number[]) => string
  /** The pre-flight simulation of a claim of `epochs`. */
  check: (epochs: readonly number[]) => Promise<unknown>
  send: (epochs: readonly number[]) => Promise<`0x${string}`>
  /** Called with a transaction's epochs once it confirms. */
  onClaimed: (epochs: readonly number[]) => void
}

/** The transactions claiming `epochs`: one per epoch when `perEpoch` (builders), else one for all of them (referrals). */
export function claimSteps(epochs: readonly number[], perEpoch: boolean, calls: ClaimCalls): TxStep[] {
  const batches = perEpoch ? epochs.map((epoch) => [epoch]) : epochs.length > 0 ? [[...epochs]] : []
  return batches.map((batch) => ({
    label: calls.label(batch),
    check: () => calls.check(batch),
    send: () => calls.send(batch),
    onConfirmed: () => calls.onClaimed(batch),
  }))
}
