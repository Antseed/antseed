import { Alert } from '@antseed/ui'
import type { ChainInfo } from '../api/types'
import { explorerTxUrl } from '../lib/chain'
import type { useTxRunner } from './useTx'

/** Pending, failed and confirmed states of a wallet transaction, with an explorer link. */
export function TxFeedback({ chain, runner, done = 'Confirmed on chain.' }: { chain: ChainInfo; runner: ReturnType<typeof useTxRunner>; done?: string }) {
  const url = runner.lastHash ? explorerTxUrl(chain, runner.lastHash) : null
  const link = url && <a className="gc-link" href={url} target="_blank" rel="noopener noreferrer">View transaction</a>
  return (
    <>
      {runner.status && <Alert tone="info">{runner.status} {runner.running && runner.lastHash && link}</Alert>}
      {runner.error && <Alert tone="danger">{runner.error} {!runner.running && link}</Alert>}
      {!runner.running && !runner.error && runner.confirmed && <Alert tone="success">{done} {link}</Alert>}
    </>
  )
}
