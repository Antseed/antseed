/** A wallet transaction the console sends, in a sequence run by `useTxRunner` (wallet/useTx.ts). */
export interface TxStep {
  label: string
  /** Runs before the wallet prompt (e.g. a contract simulation); a throw stops here, nothing is sent. */
  check?: () => Promise<unknown>
  send: () => Promise<`0x${string}`>
  /** Runs once this step's transaction is confirmed, before the next step starts (e.g. to leave a claimed epoch out of a retry). */
  onConfirmed?: () => void
}

export interface TxStepIo {
  status: (text: string) => void
  sent: (hash: `0x${string}`) => void
  receipt: (hash: `0x${string}`) => Promise<{ status: string }>
}

/**
 * Checks, sends and waits for each step in order. Throws on the first
 * failure, so the steps before it stay confirmed; resolves to the last hash.
 */
export async function runTxSteps(steps: readonly TxStep[], io: TxStepIo): Promise<`0x${string}` | null> {
  let last: `0x${string}` | null = null
  for (const step of steps) {
    if (step.check) {
      io.status(`${step.label}: checking…`)
      await step.check()
    }
    io.status(`${step.label}: confirm in your wallet…`)
    const hash = await step.send()
    last = hash
    io.sent(hash)
    io.status(`${step.label}: waiting for confirmation…`)
    const receipt = await io.receipt(hash)
    if (receipt.status !== 'success') throw new Error(`${step.label} reverted on chain.`)
    step.onConfirmed?.()
  }
  return last
}
