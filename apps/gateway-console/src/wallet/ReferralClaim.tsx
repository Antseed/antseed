import { useState } from 'react'
import { useAccount, useConfig, useWriteContract } from 'wagmi'
import { readContract, simulateContract } from 'wagmi/actions'
import { Alert, Button } from '@antseed/ui'
import type { ChainInfo } from '../api/types'
import { contractAddress } from '../lib/chain'
import { claimedOnChain, claimSteps, unclaimedEpochs } from '../lib/claims'
import { shortId } from '../lib/format'
import { CLIENT_REWARDS_CLAIM_ABI, REFERRALS_CLAIM_ABI } from './operator-abi'
import { ConnectedWallet, ConnectWalletButton } from './ConnectWallet'
import { WalletProvider } from './provider'
import { TxFeedback } from './TxFeedback'
import { useTxRunner, type TxStep } from './useTx'

/**
 * What to claim. Every claim is permissionless: any connected wallet sends
 * it and pays gas, and the contract picks who is paid.
 */
export type ClaimTarget =
  /** Referral rewards of `address` (AntseedReferrals.claimEpochs, one transaction). */
  | { kind: 'referrer'; address: string; epochs: number[] }
  /** The invite bonus of buyer `address` (AntseedReferrals.claimRefereeEpochs, one transaction). */
  | { kind: 'referee'; address: string; epochs: number[] }
  /** Builders rewards of `agentId` (AntseedClientRewards.claim, one transaction per epoch). */
  | { kind: 'builder'; agentId: number; epochs: number[] }

interface Props {
  target: ClaimTarget
  chain: ChainInfo
  /** Where the ANTS go, for the copy above the button. */
  recipient: string | null
  /**
   * After transactions confirmed: `complete` once the whole claim did, false
   * when a later one failed part way (the rewards view is stale either way).
   */
  onClaimed: (complete: boolean) => void
}

function Claim({ target, chain, recipient, onClaimed }: Props) {
  const { address } = useAccount()
  const config = useConfig()
  const runner = useTxRunner(chain.chainId)
  const { writeContractAsync } = useWriteContract()
  // Epochs confirmed while this dialog is open; a retry leaves them out.
  const [claimed, setClaimed] = useState<ReadonlySet<number>>(() => new Set())
  const [checking, setChecking] = useState(false)
  const builder = target.kind === 'builder'
  const contract = contractAddress(chain, builder ? 'clientRewards' : 'referrals')
  const epochs = unclaimedEpochs(target.epochs, claimed)

  if (!contract) {
    return <Alert tone="warning">The gateway did not report the {builder ? 'builders rewards' : 'referrals'} contract address.</Alert>
  }
  const chainId = chain.chainId
  const markClaimed = (done: readonly number[]) => setClaimed((previous) => new Set([...previous, ...done]))
  const plan = (pending: readonly number[], onConfirmed: (done: readonly number[]) => void): TxStep[] => {
    if (target.kind === 'builder') {
      const args = (epoch: number) => [BigInt(target.agentId), BigInt(epoch)] as const
      return claimSteps(pending, true, {
        label: ([epoch]) => `Claim epoch ${epoch}`,
        check: ([epoch]) => simulateContract(config, { account: address, address: contract, abi: CLIENT_REWARDS_CLAIM_ABI, functionName: 'claim', args: args(epoch!), chainId }),
        send: ([epoch]) => writeContractAsync({ address: contract, abi: CLIENT_REWARDS_CLAIM_ABI, functionName: 'claim', args: args(epoch!), chainId }),
        onClaimed: onConfirmed,
      })
    }
    const functionName = target.kind === 'referrer' ? 'claimEpochs' : 'claimRefereeEpochs'
    const args = (batch: readonly number[]) => [target.address as `0x${string}`, batch.map(BigInt)] as const
    return claimSteps(pending, false, {
      label: () => target.kind === 'referrer' ? 'Claim referral rewards' : 'Claim the invite bonus',
      check: (batch) => simulateContract(config, { account: address, address: contract, abi: REFERRALS_CLAIM_ABI, functionName, args: args(batch), chainId }),
      send: (batch) => writeContractAsync({ address: contract, abi: REFERRALS_CLAIM_ABI, functionName, args: args(batch), chainId }),
      onClaimed: onConfirmed,
    })
  }

  const claim = async () => {
    let pending = epochs
    if (target.kind === 'builder') {
      // Epochs an earlier attempt confirmed may still be listed by the explorer.
      setChecking(true)
      const agentId = BigInt(target.agentId)
      const done = await claimedOnChain(pending, (epoch) => readContract(config, {
        address: contract, abi: CLIENT_REWARDS_CLAIM_ABI, functionName: 'claimed', args: [agentId, BigInt(epoch)], chainId,
      })).finally(() => setChecking(false))
      if (done.length > 0) {
        markClaimed(done)
        pending = unclaimedEpochs(pending, new Set(done))
        if (pending.length === 0) return onClaimed(true)
      }
    }
    let confirmed = 0
    const hash = await runner.run(plan(pending, (done) => { confirmed += 1; markClaimed(done) }))
    if (hash) onClaimed(true)
    else if (confirmed > 0) onClaimed(false)
  }

  const transactions = builder ? epochs.length : Math.min(epochs.length, 1)
  const busy = runner.running || checking
  return (
    <div className="gc-stack">
      <p className="gc-fineprint">
        Any connected wallet can send this and pays the gas.{recipient ? <> The ANTS go to {shortId(recipient)}.</> : null}
      </p>
      <TxFeedback chain={chain} runner={runner} done="Rewards claimed." />
      {address ? (
        <Button disabled={busy || transactions === 0} onClick={() => void claim()}>
          {busy ? 'Claiming…' : transactions === 0 ? 'Nothing to claim' : transactions === 1 ? 'Claim' : `Claim (${transactions} transactions)`}
        </Button>
      ) : <ConnectWalletButton />}
      {builder && transactions > 1 && <p className="gc-fineprint">The builders contract claims one epoch per transaction.</p>}
    </div>
  )
}

export default function ReferralClaim(props: Props) {
  return (
    <WalletProvider chain={props.chain}>
      <div className="gc-stack">
        <ConnectedWallet />
        <Claim {...props} />
      </div>
    </WalletProvider>
  )
}
