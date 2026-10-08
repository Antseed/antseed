import { useState, type ReactNode } from 'react'
import { useAccount, useConfig, useReadContract, useWriteContract } from 'wagmi'
import { simulateContract } from 'wagmi/actions'
import { formatUnits, parseUnits } from 'viem'
import { DEPOSITS_ABI, ERC20_ABI } from '@antseed/wallet-config/abis'
import { Alert, Button, TextField } from '@antseed/ui'
import type { ChainInfo, Wallet } from '../api/types'
import { contractAddress } from '../lib/chain'
import { operatorGate, useOperator, useOperatorRefresh } from '../lib/operator'
import { formatUsd, shortId, usdcToNumber } from '../lib/format'
import { DEPOSITS_OPERATOR_ABI } from './operator-abi'
import { ConnectedWallet, ConnectWalletButton as Connect } from './ConnectWallet'
import { WalletProvider } from './provider'
import { TxFeedback } from './TxFeedback'
import { useTxRunner } from './useTx'

const MIN_FIRST_DEPOSIT = 1 // USDC, matches AntseedDeposits.MIN_BUYER_DEPOSIT

type FundingAction = 'deposit' | 'withdraw'

interface Props {
  action: FundingAction
  workspaceId: string
  wallet: Wallet
  chain: ChainInfo
  onDone: (hash: string | null) => void
}

function parseAmount(amount: string): bigint {
  try { return parseUnits(amount.trim() || '0', 6) } catch { return 0n }
}

/** Approve USDC then AntseedDeposits.deposit(buyer, amount) from the connected wallet. */
function Deposit({ wallet, chain, onDone }: Props) {
  const { address } = useAccount()
  const runner = useTxRunner(chain.chainId)
  const { writeContractAsync } = useWriteContract()
  const [amount, setAmount] = useState('')
  const usdc = contractAddress(chain, 'usdc')
  const deposits = contractAddress(chain, 'deposits')
  const balance = useReadContract({ address: usdc ?? undefined, abi: ERC20_ABI, functionName: 'balanceOf', args: address ? [address] : undefined, chainId: chain.chainId, query: { enabled: !!usdc && !!address, staleTime: 60_000, refetchOnWindowFocus: false } })
  const allowance = useReadContract({ address: usdc ?? undefined, abi: ERC20_ABI, functionName: 'allowance', args: address && deposits ? [address, deposits] : undefined, chainId: chain.chainId, query: { enabled: !!usdc && !!address && !!deposits, staleTime: 60_000, refetchOnWindowFocus: false } })

  if (!usdc || !deposits) return <Alert tone="warning">The gateway did not report the USDC and deposits contract addresses.</Alert>
  if (!address) return <Connect label="Connect wallet to pay" />

  const units = parseAmount(amount)
  const walletUnits = balance.data
  const firstDeposit = usdcToNumber(wallet.available) + usdcToNumber(wallet.reserved) === 0
  let validation: string | null = null
  if (amount !== '') {
    if (units <= 0n || !/^\d+(\.\d{0,6})?$/.test(amount.trim())) validation = 'Enter an amount like 20 or 12.50.'
    else if (firstDeposit && Number(amount) < MIN_FIRST_DEPOSIT) validation = `The first deposit is at least ${MIN_FIRST_DEPOSIT} USDC.`
    else if (walletUnits !== undefined && units > walletUnits) validation = `Your wallet holds ${formatUsd(Number(formatUnits(walletUnits, 6)))} USDC.`
  }
  const needsApproval = allowance.data !== undefined && allowance.data < units

  async function pay() {
    const steps = []
    const latest = await allowance.refetch()
    if ((latest.data ?? 0n) < units) {
      steps.push({ label: 'Approve USDC', send: () => writeContractAsync({ address: usdc!, abi: ERC20_ABI, functionName: 'approve', args: [deposits!, units], chainId: chain.chainId }) })
    }
    steps.push({ label: 'Deposit', send: () => writeContractAsync({ address: deposits!, abi: DEPOSITS_ABI, functionName: 'deposit', args: [wallet.address as `0x${string}`, units], chainId: chain.chainId }) })
    const hash = await runner.run(steps)
    if (hash) {
      setAmount('')
      void balance.refetch()
      onDone(hash)
    }
  }

  return (
    <div className="gc-stack">
      <div className="gc-kv"><span>Paying from</span><code>{shortId(address)}</code><span>{walletUnits !== undefined ? `${formatUsd(Number(formatUnits(walletUnits, 6)))} USDC` : '…'}</span></div>
      <TextField label="Amount (USDC)" inputMode="decimal" placeholder="20" value={amount} error={validation} onChange={(event) => setAmount(event.target.value)} />
      <TxFeedback chain={chain} runner={runner} />
      <Button fullWidth disabled={runner.running || !amount || !!validation} onClick={() => void pay()}>
        {runner.running ? 'Working…' : `Pay ${amount ? formatUsd(Number(amount)) : ''} USDC`}
      </Button>
      <p className="gc-fineprint">
        {needsApproval ? 'You will confirm two transactions: a one-time USDC approval, then the deposit.' : 'You will confirm one transaction.'} Network fees are paid in ETH on {chain.name}.
      </p>
    </div>
  )
}

/**
 * AntseedDeposits.withdraw(buyer, amount): only the authorized wallet can
 * call it and the USDC goes to that wallet. Gated on the operator the
 * gateway reads from the chain, not on the cached balance read.
 */
function Withdraw({ workspaceId, wallet, chain, onDone }: Props) {
  const { address } = useAccount()
  const config = useConfig()
  const runner = useTxRunner(chain.chainId)
  const { writeContractAsync } = useWriteContract()
  const operator = useOperator(workspaceId)
  const { refresh } = useOperatorRefresh(workspaceId)
  const [amount, setAmount] = useState('')
  const deposits = contractAddress(chain, 'deposits')
  if (!deposits) return <Alert tone="warning">The gateway did not report the deposits contract address.</Alert>
  const gate = operatorGate(operator.data, address, 'withdraw')
  if (!gate.ok) {
    return (
      <div className="gc-stack">
        <Alert tone={gate.operator ? 'warning' : 'info'} title={gate.operator ? 'Use the authorized wallet' : 'No authorized wallet'}>{gate.reason}</Alert>
        {gate.operator && !address && <Connect label={`Connect ${shortId(gate.operator)}`} />}
      </div>
    )
  }
  const units = parseAmount(amount)
  const available = usdcToNumber(wallet.available)
  let validation: string | null = null
  if (amount !== '') {
    if (units <= 0n || !/^\d+(\.\d{0,6})?$/.test(amount.trim())) validation = 'Enter an amount like 20 or 12.50.'
    else if (Number(amount) > available) validation = `Only ${formatUsd(available)} is available.`
  }
  return (
    <div className="gc-stack">
      <div className="gc-kv"><span>Sending to</span><code>{shortId(address)}</code><span>{formatUsd(available)} available</span></div>
      <TextField label="Amount (USDC)" inputMode="decimal" value={amount} error={validation} onChange={(event) => setAmount(event.target.value)} />
      <TxFeedback chain={chain} runner={runner} done="Withdrawal confirmed." />
      <Button fullWidth disabled={runner.running || !amount || !!validation}
        onClick={async () => {
          const args = [wallet.address as `0x${string}`, units] as const
          const hash = await runner.run([{
            label: 'Withdraw',
            check: () => simulateContract(config, { account: address, address: deposits, abi: DEPOSITS_OPERATOR_ABI, functionName: 'withdraw', args, chainId: chain.chainId }),
            send: () => writeContractAsync({ address: deposits, abi: DEPOSITS_OPERATOR_ABI, functionName: 'withdraw', args, chainId: chain.chainId }),
          }], { onStale: () => void refresh().catch(() => undefined) })
          if (hash) { setAmount(''); onDone(hash) }
        }}>
        {runner.running ? 'Working…' : 'Withdraw'}
      </Button>
      <p className="gc-fineprint">Reserved funds in open channels stay locked until the channels close.</p>
    </div>
  )
}

const BODIES: Record<FundingAction, (props: Props) => ReactNode> = { deposit: Deposit, withdraw: Withdraw }

export default function WalletFunding(props: Props) {
  const Body = BODIES[props.action]
  return (
    <WalletProvider chain={props.chain}>
      <div className="gc-stack">
        <ConnectedWallet />
        <Body {...props} />
      </div>
    </WalletProvider>
  )
}
