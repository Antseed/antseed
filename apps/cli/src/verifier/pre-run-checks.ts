/**
 * Checks `verifier run` makes before sending anything, so problems on the auditor's side stop the
 * run with one clear message instead of turning into failed or UNDETERMINED audits.
 */

export const DEFAULT_MAX_RESERVE_AMOUNT_USDC = 1_000_000n

/** `$1.50`; USDC has 6 decimals. */
export function formatUsdcAmount(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n
  const cents = (baseUnits % 1_000_000n) / 10_000n
  return `$${whole}.${cents.toString().padStart(2, '0')}`
}

/**
 * Each seller without an open payment channel needs a new one, which locks `reserve` of the
 * deposit until it closes. Null when the available deposit covers all of them.
 */
export function depositShortfall(input: {
  availableUsdc: bigint
  reserveUsdc: bigint
  newChannelCount: number
}): string | null {
  const needed = input.reserveUsdc * BigInt(input.newChannelCount)
  if (input.newChannelCount === 0 || input.availableUsdc >= needed) return null
  return `${input.newChannelCount} seller(s) need a new payment channel, each reserving ${formatUsdcAmount(input.reserveUsdc)} `
    + `(payments.maxReserveAmountUsdc): ${formatUsdcAmount(needed)} needed, ${formatUsdcAmount(input.availableUsdc)} available. `
    + `Deposit at least ${formatUsdcAmount(needed - input.availableUsdc)} more (antseed buyer deposit), `
    + 'or lower payments.maxReserveAmountUsdc and restart the buyer'
}

/** Problems with a model's probe bank for the sellers of this run; empty when it is ready. */
export function probeBankProblems(input: {
  model: string
  sellers: ReadonlyArray<{ sellerPeerId: string; unseenProbeCount: number; neededProbeCount: number }>
  enrollIfNeeded: boolean
}): string[] {
  if (input.enrollIfNeeded) return []
  const short = input.sellers.filter((seller) => seller.unseenProbeCount < seller.neededProbeCount)
  if (short.length === 0) return []
  const worst = short.reduce((low, seller) => seller.unseenProbeCount < low.unseenProbeCount ? seller : low)
  return [
    `${input.model}: ${short.length} seller(s) have too few unseen questions for an audit and a DIFF recheck `
    + `(lowest: ${worst.unseenProbeCount} of ${worst.neededProbeCount} needed, seller ${worst.sellerPeerId.slice(0, 12)}…). `
    + 'Run without --no-enroll to add fresh questions',
  ]
}

/** The error that stops a run, listing every problem found before it started. */
export function preRunError(problems: readonly string[]): Error {
  return new Error(
    `verifier run stopped before sending any request: ${problems.length} problem(s) on the auditor's side:\n`
    + problems.map((problem) => `  - ${problem}`).join('\n'),
  )
}
