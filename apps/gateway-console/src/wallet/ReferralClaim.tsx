import { useAccount, useConfig, useWriteContract } from 'wagmi'
import { simulateContract } from 'wagmi/actions'
import { Alert, Button } from '@antseed/ui'
import type { ChainInfo } from '../api/types'
import { contractAddress } from '../lib/chain'
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
  onDone: () => void
}

function steps(target: ClaimTarget, chain: ChainInfo, account: `0x${string}` | undefined, config: ReturnType<typeof useConfig>, write: ReturnType<typeof useWriteContract>['writeContractAsync']): TxStep[] | null {
  const chainId = chain.chainId
  if (target.kind === 'builder') {
    const contract = contractAddress(chain, 'clientRewards')
    if (!contract) return null
    return target.epochs.map((epoch) => {
      const args = [BigInt(target.agentId), BigInt(epoch)] as const
      return {
        label: `Claim epoch ${epoch}`,
        check: () => simulateContract(config, { account, address: contract, abi: CLIENT_REWARDS_CLAIM_ABI, functionName: 'claim', args, chainId }),
        send: () => write({ address: contract, abi: CLIENT_REWARDS_CLAIM_ABI, functionName: 'claim', args, chainId }),
      }
    })
  }
  const contract = contractAddress(chain, 'referrals')
  if (!contract) return null
  const functionName = target.kind === 'referrer' ? 'claimEpochs' : 'claimRefereeEpochs'
  const args = [target.address as `0x${string}`, target.epochs.map(BigInt)] as const
  return [{
    label: target.kind === 'referrer' ? 'Claim referral rewards' : 'Claim the invite bonus',
    check: () => simulateContract(config, { account, address: contract, abi: REFERRALS_CLAIM_ABI, functionName, args, chainId }),
    send: () => write({ address: contract, abi: REFERRALS_CLAIM_ABI, functionName, args, chainId }),
  }]
}

function Claim({ target, chain, recipient, onDone }: Props) {
  const { address } = useAccount()
  const config = useConfig()
  const runner = useTxRunner(chain.chainId)
  const { writeContractAsync } = useWriteContract()
  const planned = steps(target, chain, address, config, writeContractAsync)

  if (!planned) {
    return <Alert tone="warning">The gateway did not report the {target.kind === 'builder' ? 'builders rewards' : 'referrals'} contract address.</Alert>
  }
  const transactions = planned.length
  return (
    <div className="gc-stack">
      <p className="gc-fineprint">
        Any connected wallet can send this and pays the gas.{recipient ? <> The ANTS go to {shortId(recipient)}.</> : null}
      </p>
      <TxFeedback chain={chain} runner={runner} done="Rewards claimed." />
      {address ? (
        <Button disabled={runner.running || transactions === 0} onClick={async () => {
          const hash = await runner.run(planned)
          if (hash) onDone()
        }}>
          {runner.running ? 'Claiming…' : transactions === 1 ? 'Claim' : `Claim (${transactions} transactions)`}
        </Button>
      ) : <ConnectWalletButton />}
      {transactions > 1 && <p className="gc-fineprint">The builders contract claims one epoch per transaction.</p>}
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
