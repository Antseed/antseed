import { useAccount, useConfig, useWriteContract } from 'wagmi'
import { simulateContract } from 'wagmi/actions'
import { Alert, Button } from '@antseed/ui'
import type { ChainInfo, Rewards } from '../api/types'
import { useConsole } from '../app/context'
import { contractAddress } from '../lib/chain'
import { antsIsPositive } from '../lib/ants'
import { shortId } from '../lib/format'
import { operatorGate, useOperator, useOperatorRefresh } from '../lib/operator'
import { USAGE_REWARDS_OPERATOR_ABI } from './operator-abi'
import { ConnectedWallet, ConnectWalletButton } from './ConnectWallet'
import { WalletProvider } from './provider'
import { TxFeedback } from './TxFeedback'
import { useTxRunner } from './useTx'

interface Props {
  rewards: Rewards
  chain: ChainInfo
  onDone: () => void
}

function claimLabel(running: boolean, epochs: number): string {
  if (running) return 'Claiming…'
  if (epochs === 0) return 'Nothing to claim'
  return `Claim ${epochs} epoch${epochs === 1 ? '' : 's'}`
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

  if (!contract) return <Alert tone="warning">The gateway did not report the usage rewards contract address.</Alert>
  const gate = operatorGate(operator.data, address, 'claim rewards')
  if (!gate.ok) {
    return (
      <div className="gc-stack">
        <Alert tone={gate.operator ? 'warning' : 'info'} title={gate.operator ? 'Use the authorized wallet' : 'No authorized wallet'}>{gate.reason}</Alert>
        {gate.operator && !address && (
          <ConnectWalletButton label={`Connect ${shortId(gate.operator)} to claim`} />
        )}
      </div>
    )
  }
  return (
    <div className="gc-stack">
      <p className="gc-fineprint">The ANTS go to {shortId(gate.operator)}, the connected authorized wallet.</p>
      <TxFeedback chain={chain} runner={runner} done="Rewards claimed." />
      <Button disabled={runner.running || epochs.length === 0} onClick={async () => {
        const hash = await runner.run(epochs.map((epoch) => {
          const args = [rewards.address as `0x${string}`, BigInt(epoch.epoch)] as const
          return {
            label: `Claim epoch ${epoch.epoch}`,
            check: () => simulateContract(config, { account: address, address: contract, abi: USAGE_REWARDS_OPERATOR_ABI, functionName: 'claimBuyerReward', args, chainId: chain.chainId }),
            send: () => writeContractAsync({ address: contract, abi: USAGE_REWARDS_OPERATOR_ABI, functionName: 'claimBuyerReward', args, chainId: chain.chainId }),
          }
        }), { onStale: () => void refresh().catch(() => undefined) })
        if (hash) onDone()
      }}>
        {claimLabel(runner.running, epochs.length)}
      </Button>
      {epochs.length > 1 && <p className="gc-fineprint">Each epoch is its own transaction.</p>}
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
