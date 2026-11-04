import { useState } from 'react'
import { useAccount, useConfig, useSwitchChain } from 'wagmi'
import { waitForTransactionReceipt } from 'wagmi/actions'
import { OperatorPreflightError, operatorTxError } from '../lib/operator'
import { runTxSteps, type TxStep } from '../lib/tx-steps'
import { walletError } from './provider'

export type { TxStep }

export interface TxOptions {
  /** Called when a failure means the shown on-chain state is stale (e.g. OperatorAlreadySet). */
  onStale?: () => void
}

/**
 * Runs a sequence of wallet transactions on the gateway's chain: switches
 * network if needed, then each step checks, sends and waits for its receipt.
 * Contract reverts are named (see lib/operator.ts) rather than shown raw.
 */
export function useTxRunner(chainId: number) {
  const config = useConfig()
  const { chainId: walletChainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastHash, setLastHash] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  /** Resolves to the last transaction hash on success, null on failure (the error is in `error`). */
  async function run(steps: TxStep[], options: TxOptions = {}): Promise<string | null> {
    let last: string | null = null
    setRunning(true)
    setError(null)
    setConfirmed(null)
    setLastHash(null)
    try {
      if (walletChainId !== chainId) {
        setStatus('Switch network in your wallet…')
        await switchChainAsync({ chainId })
      }
      await runTxSteps(steps, {
        status: setStatus,
        sent: (hash) => { last = hash; setLastHash(hash) },
        receipt: (hash) => waitForTransactionReceipt(config, { hash, chainId }),
      })
      setStatus(null)
      setConfirmed(last)
      return last
    } catch (cause) {
      setStatus(null)
      const named = operatorTxError(cause)
      if (named) {
        setError(named.message)
        if (named.refresh) options.onStale?.()
      } else if (cause instanceof OperatorPreflightError) {
        setError(cause.message)
        if (cause.refresh) options.onStale?.()
      } else {
        setError(walletError(cause))
        if (last) options.onStale?.()
      }
      return null
    } finally {
      setRunning(false)
    }
  }

  return { run, running, status, setStatus, error, lastHash, confirmed, wrongChain: walletChainId !== undefined && walletChainId !== chainId, setError }
}
