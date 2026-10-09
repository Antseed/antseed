import { useAccount, useConfig, useWriteContract } from 'wagmi'
import { simulateContract } from 'wagmi/actions'
import { Alert, Button } from '@antseed/ui'
import type { ChainInfo, Rewards } from '../api/types'
import { useConsole } from '../app/context'
import { contractAddress } from '../lib/chain'
import { antsIsPositive } from '../lib/ants'
import { shortId } from '../lib/format'
import { operatorGate, useOperator, useOperatorRefresh } from '../lib/operator'
import { LEGACY_EMISSIONS_BUYER_ABI, USAGE_REWARDS_OPERATOR_ABI } from './operator-abi'
import { ConnectedWallet } from './ConnectWallet'
import { OperatorGateAlert } from './OperatorGateAlert'
import { WalletProvider } from './provider'
import { TxFeedback } from './TxFeedback'
import { useTxRunner, type TxStep } from './useTx'

interface Props {
  rewards: Rewards
  chain: ChainInfo
  onDone: () => void
}

function claimLabel(running: boolean, transactions: number): string {
  if (running) return 'Claiming…'
  if (transactions === 0) return 'Nothing to claim'
  return transactions === 1 ? 'Claim' : `Claim (${transactions} transactions)`
}

/**
 * Claims each unclaimed epoch with UsageRewards.claimBuyerReward(buyer,
 * epoch). Only the authorized wallet may call it, and the ANTS go to it; the
 * gate uses the operator the gateway reads from the chain.
 */
function Claim({ rewards, chain, onDone }: Props) {
  const { address } = useAccount()
  const config = useConfig()
  const { workspace } = useConsole()
  const operator = useOperator(workspace.id)
  const { refresh } = useOperatorRefresh(workspace.id)
  const runner = useTxRunner(chain.chainId)
  const { writeContractAsync } = useWriteContract()
  const contract = contractAddress(chain, 'usageRewards')
  const epochs = rewards.epochs.filter((epoch) => !epoch.claimed && antsIsPositive(epoch.pendingAnts))
  const legacy = rewards.legacy && antsIsPositive(rewards.legacy.pendingAnts) ? rewards.legacy : null
  const transactions = epochs.length + (legacy ? 1 : 0)

  if (!contract) return <Alert tone="warning">The gateway did not report the usage rewards contract address.</Alert>
  const gate = operatorGate(operator.data, address, 'claim rewards')
  if (!gate.ok) return <OperatorGateAlert gate={gate} state={operator.data} connected={address} />
  return (
    <div className="gc-stack">
      <p className="gc-fineprint">The ANTS go to {shortId(gate.operator)}, the connected authorized wallet.</p>
      <TxFeedback chain={chain} runner={runner} done="Rewards claimed." />
      <Button disabled={runner.running || transactions === 0} onClick={async () => {
        const steps: TxStep[] = epochs.map((epoch) => {
          const args = [rewards.address as `0x${string}`, BigInt(epoch.epoch)] as const
          return {
            label: `Claim epoch ${epoch.epoch}`,
            check: () => simulateContract(config, { account: address, address: contract, abi: USAGE_REWARDS_OPERATOR_ABI, functionName: 'claimBuyerReward', args, chainId: chain.chainId }),
            send: () => writeContractAsync({ address: contract, abi: USAGE_REWARDS_OPERATOR_ABI, functionName: 'claimBuyerReward', args, chainId: chain.chainId }),
          }
        })
        if (legacy) {
          const args = [rewards.address as `0x${string}`, legacy.epochs.map(BigInt)] as const
          const target = legacy.contract as `0x${string}`
          steps.push({
            label: 'Claim legacy emissions',
            check: () => simulateContract(config, { account: address, address: target, abi: LEGACY_EMISSIONS_BUYER_ABI, functionName: 'claimBuyerEmissions', args, chainId: chain.chainId }),
            send: () => writeContractAsync({ address: target, abi: LEGACY_EMISSIONS_BUYER_ABI, functionName: 'claimBuyerEmissions', args, chainId: chain.chainId }),
          })
        }
        const hash = await runner.run(steps, { onStale: () => void refresh().catch(() => undefined) })
        if (hash) onDone()
      }}>
        {claimLabel(runner.running, transactions)}
      </Button>
      {transactions > 1 && <p className="gc-fineprint">Each current-program epoch is its own transaction; legacy emissions are one more.</p>}
    </div>
  )
}

export default function RewardsClaim(props: Props) {
  return (
    <WalletProvider chain={props.chain}>
      <div className="gc-stack">
        <ConnectedWallet />
        <Claim {...props} />
      </div>
    </WalletProvider>
  )
}
