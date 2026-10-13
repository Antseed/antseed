import { useAccount, useConfig, useWriteContract } from 'wagmi'
import { readContract, simulateContract } from 'wagmi/actions'
import { Alert, Button } from '@antseed/ui'
import type { Channel, ChainInfo } from '../api/types'
import { CopyButton } from '../components/ui'
import { contractAddress } from '../lib/chain'
import { CHANNEL_CLOSE_GRACE_MS, formatCountdown, unspent, withdrawableAt } from '../lib/channels'
import { formatUsd, shortId } from '../lib/format'
import { OperatorPreflightError, operatorGate, useOperator, useOperatorRefresh } from '../lib/operator'
import { CHANNELS_CLOSE_ABI } from './operator-abi'
import { ConnectedWallet } from './ConnectWallet'
import { OperatorGateAlert } from './OperatorGateAlert'
import { WalletProvider } from './provider'
import { TxFeedback } from './TxFeedback'
import { useTxRunner } from './useTx'

type Hex = `0x${string}`

/** On-chain channel status: 0 none, 1 active, 2 settled, 3 timed out (withdrawn). */
const ACTIVE = 1

export interface ChannelCloseProps {
  workspaceId: string
  channel: Channel
  chain: ChainInfo
  /** `request` starts the grace period; `withdraw` returns the unused reserve once it ends. */
  step: 'request' | 'withdraw'
  /** A transaction confirmed (or the chain says there is nothing to do): re-read the channels. */
  onDone: (step: 'request' | 'withdraw') => void
  /** Open the authorize flow (no authorized wallet yet, and the viewer may set one). */
  onAuthorize?: () => void
}

const VERB = { request: 'close channels on chain', withdraw: 'withdraw channel reserves' } as const

/** The gateway-held wallet is its own operator: the CLI on the gateway host signs with it. */
function CliFallback({ channel, step }: { channel: Channel; step: 'request' | 'withdraw' }) {
  const command = `antseed buyer channels ${step === 'request' ? 'request-close' : 'withdraw'} ${channel.channelId}`
  return (
    <div className="gc-stack gc-stack--tight">
      <p className="gc-muted">This workspace's authorized wallet is the wallet the gateway holds, so a browser wallet cannot sign this. Run on the gateway host (the workspace wallet pays the network fee in ETH):</p>
      <div className="gc-address"><code className="gc-mono">{command}</code><CopyButton value={command} label="Copy command" /></div>
    </div>
  )
}

function Steps({ workspaceId, channel, chain, step, onDone, onAuthorize }: ChannelCloseProps) {
  const { address } = useAccount()
  const config = useConfig()
  const operator = useOperator(workspaceId)
  const { refresh } = useOperatorRefresh(workspaceId)
  const runner = useTxRunner(chain.chainId)
  const { writeContractAsync } = useWriteContract()
  const contract = contractAddress(chain, 'channels')
  if (!contract) return <Alert tone="warning">The gateway did not report the payment channels contract address.</Alert>

  if (operator.data?.relation === 'self') return <CliFallback channel={channel} step={step} />
  const gate = operatorGate(operator.data, address, VERB[step])
  if (!gate.ok) return <OperatorGateAlert gate={gate} state={operator.data} connected={address} onAuthorize={onAuthorize} />

  const channelId = channel.channelId as Hex
  /** Live on-chain state right before signing, so a stale row cannot send a doomed transaction. */
  async function preflight(): Promise<void> {
    const [, , , , , , , closeRequestedAt, status] = await readContract(config, { address: contract!, abi: CHANNELS_CLOSE_ABI, functionName: 'channels', args: [channelId], chainId: chain.chainId })
    if (status !== ACTIVE) throw new OperatorPreflightError('This channel is already settled or closed; nothing is left to do. The list now shows it.', true)
    if (step === 'request' && closeRequestedAt > 0n) throw new OperatorPreflightError('A close was already requested for this channel. The list now shows when the reserve can be withdrawn.', true)
    if (step === 'withdraw' && Number(closeRequestedAt) * 1000 + CHANNEL_CLOSE_GRACE_MS > Date.now()) {
      throw new OperatorPreflightError(`The grace period ends in ${formatCountdown(Number(closeRequestedAt) * 1000 + CHANNEL_CLOSE_GRACE_MS)}. Withdraw then.`, true)
    }
    await simulateContract(config, { account: address as Hex, address: contract!, abi: CHANNELS_CLOSE_ABI, functionName: step === 'request' ? 'requestClose' : 'withdraw', args: [channelId], chainId: chain.chainId })
  }

  async function submit() {
    const hash = await runner.run([{
      label: step === 'request' ? 'Request close' : 'Withdraw reserve',
      check: preflight,
      send: () => writeContractAsync({ address: contract!, abi: CHANNELS_CLOSE_ABI, functionName: step === 'request' ? 'requestClose' : 'withdraw', args: [channelId], chainId: chain.chainId }),
    }], {
      onStale: () => {
        void refresh().catch(() => undefined)
        onDone(step)
      },
    })
    if (hash) onDone(step)
  }

  const at = withdrawableAt(channel)
  return (
    <div className="gc-stack">
      {step === 'request'
        ? <p className="gc-muted">The seller gets 15 minutes to settle what was spent. After that, withdraw the unused reserve (about {formatUsd(unspent(channel))}) back to the workspace balance. Both steps are signed by the authorized wallet {shortId(gate.operator)}, which pays the network fee in ETH on {chain.name}.</p>
        : <p className="gc-muted">The grace period {at && at > Date.now() ? `ends in ${formatCountdown(at)}` : 'has ended'}. Withdrawing returns the unused reserve (about {formatUsd(unspent(channel))}) to the workspace balance; nothing leaves the workspace.</p>}
      <TxFeedback chain={chain} runner={runner} done={step === 'request' ? 'Close requested. Withdraw the reserve in 15 minutes.' : 'Reserve returned to the balance.'} />
      <Button fullWidth disabled={runner.running} onClick={() => void submit()}>
        {runner.running ? 'Working…' : step === 'request' ? 'Request on-chain close' : 'Withdraw unused reserve'}
      </Button>
    </div>
  )
}

/** On-chain close of one channel with the authorized wallet: request, then withdraw after the grace period. */
export default function ChannelClose(props: ChannelCloseProps) {
  return (
    <WalletProvider chain={props.chain}>
      <div className="gc-stack">
        <ConnectedWallet />
        <Steps {...props} />
      </div>
    </WalletProvider>
  )
}
