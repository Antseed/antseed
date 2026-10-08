import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAccount, useConfig, useSignMessage, useWriteContract } from 'wagmi'
import { readContract, simulateContract } from 'wagmi/actions'
import { Alert, Button, TextField } from '@antseed/ui'
import { errorMessage, isApiError } from '../api'
import type { ChainInfo } from '../api/types'
import { useConsole } from '../app/context'
import { ConfirmDialog } from '../components/ui'
import { contractAddress, sameAddress, ZERO_ADDRESS } from '../lib/chain'
import { formatDateTime, shortId } from '../lib/format'
import {
  authorizeBlocker, checkAuthorization, eligibleWallets, operatorApi, OperatorPreflightError, operatorView,
  type OperatorAuthorization, type OperatorState,
} from '../lib/operator'
import { qk } from '../lib/queries'
import { assertSameMember, isPasskeyCancel, PASSKEY_CANCELLED, reauthWithPasskey, reauthWithWallet } from '../lib/reauth'
import { DEPOSITS_OPERATOR_ABI } from './operator-abi'
import { ConnectedWallet, ConnectWalletButton as Connect } from './ConnectWallet'
import { WalletProvider } from './provider'
import { TxFeedback } from './TxFeedback'
import { useTxRunner } from './useTx'

type Hex = `0x${string}`

export interface OperatorActionsProps {
  workspaceId: string
  state: OperatorState
  chain: ChainInfo
  /** Called with the state re-read from the chain after a confirmed transaction. */
  onChanged: (state: OperatorState) => void
  /** The shown state is stale (a revert said so): re-read it. */
  onStale: () => void
}

/**
 * Asks the gateway to re-read the operator after a confirmed transaction,
 * retrying briefly while its RPC (or its 3 s re-read throttle) lags behind.
 */
async function syncExpecting(workspaceId: string, hash: string, expected: string | null): Promise<OperatorState> {
  let state = await operatorApi.sync(workspaceId, hash)
  for (let attempt = 0; attempt < 3 && !sameAddress(state.operator ?? ZERO_ADDRESS, expected ?? ZERO_ADDRESS); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3_500))
    state = await operatorApi.sync(workspaceId, hash)
  }
  return state
}

/** Live operator and nonce from the connected wallet's RPC, right before a transaction. */
function useLiveOperator(chain: ChainInfo) {
  const config = useConfig()
  const deposits = contractAddress(chain, 'deposits')
  return async (buyer: string): Promise<{ operator: string | null; nonce: bigint }> => {
    if (!deposits) throw new OperatorPreflightError('The gateway did not report the deposits contract address.', false)
    const [operator, nonce] = await Promise.all([
      readContract(config, { address: deposits, abi: DEPOSITS_OPERATOR_ABI, functionName: 'getOperator', args: [buyer as Hex], chainId: chain.chainId }),
      readContract(config, { address: deposits, abi: DEPOSITS_OPERATOR_ABI, functionName: 'getOperatorNonce', args: [buyer as Hex], chainId: chain.chainId }),
    ])
    return { operator: sameAddress(operator, ZERO_ADDRESS) ? null : operator, nonce }
  }
}

/**
 * No operator yet: the gateway signs SetOperator for the connected wallet
 * (owner only, fresh sign-in, a sign-in wallet at least 24 h old) and the
 * connected wallet submits it. Checked against the chain just before.
 */
function Authorize({ workspaceId, state, chain, onChanged, onStale }: OperatorActionsProps) {
  const { address } = useAccount()
  const config = useConfig()
  const runner = useTxRunner(chain.chainId)
  const { writeContractAsync } = useWriteContract()
  const { signMessageAsync } = useSignMessage()
  const { me } = useConsole()
  const queryClient = useQueryClient()
  const live = useLiveOperator(chain)
  // 'any': a fresh sign-in is needed; 'other': it must not be the operator wallet itself.
  const [reauth, setReauth] = useState<false | 'any' | 'other'>(false)
  const [reauthBusy, setReauthBusy] = useState(false)
  // The wallet being authorized; kept so a confirmation with another wallet does not change the target.
  const [target, setTarget] = useState<string | null>(null)
  const deposits = contractAddress(chain, 'deposits')
  if (!deposits) return <Alert tone="warning">The gateway did not report the deposits contract address.</Alert>
  if (!address) return <Connect label="Connect the wallet to authorize" />
  const blocker = authorizeBlocker(state, address)

  async function requestAuth(operator: string): Promise<OperatorAuthorization | null> {
    try {
      const auth = await operatorApi.authorize(workspaceId, operator)
      setReauth(false)
      return auth
    } catch (error) {
      if (isApiError(error, 'reauth_required')) { setReauth('any'); runner.setError(null); return null }
      if (isApiError(error, 'reauth_other_credential')) { setReauth('other'); runner.setError(null); return null }
      if (isApiError(error, 'operator_already_set')) onStale()
      runner.setError(errorMessage(error))
      return null
    }
  }

  async function authorize(operator: string) {
    setTarget(operator)
    let auth = await requestAuth(operator)
    if (!auth) return
    const expected = { depositsContract: deposits, chainId: chain.chainId, operator }
    const hash = await runner.run([{
      label: 'Authorize wallet',
      check: async () => {
        try {
          checkAuthorization(auth!, await live(auth!.buyer), expected)
        } catch (error) {
          if (!(error instanceof OperatorPreflightError) || !error.retryAuth) throw error
          // The nonce moved (e.g. an operator was set and cleared meanwhile): sign again, once.
          runner.setStatus('The operator nonce changed; getting a fresh authorization…')
          const fresh = await operatorApi.authorize(workspaceId, operator)
          checkAuthorization(fresh, await live(fresh.buyer), expected)
          auth = fresh
        }
        await simulateContract(config, { account: address as Hex, address: deposits!, abi: DEPOSITS_OPERATOR_ABI, functionName: 'setOperator', args: [auth!.buyer as Hex, operator as Hex, BigInt(auth!.nonce), auth!.signature as Hex], chainId: chain.chainId })
      },
      send: () => writeContractAsync({ address: deposits!, abi: DEPOSITS_OPERATOR_ABI, functionName: 'setOperator', args: [auth!.buyer as Hex, operator as Hex, BigInt(auth!.nonce), auth!.signature as Hex], chainId: chain.chainId }),
    }], { onStale })
    if (hash) onChanged(await syncExpecting(workspaceId, hash, operator))
  }

  /** Fresh sign-in (passkey or this wallet), then retry the authorization. */
  async function signInAgain(method: 'passkey' | 'wallet') {
    setReauthBusy(true)
    runner.setError(null)
    try {
      const result = method === 'passkey'
        ? await reauthWithPasskey()
        : await reauthWithWallet(address!, (message) => signMessageAsync({ message }))
      assertSameMember(result, me.member.id)
      queryClient.setQueryData(qk.me, result)
      setReauth(false)
      if (target && address && !sameAddress(target, address)) {
        runner.setError(`Confirmed. Switch back to ${shortId(target)}, then authorize it.`)
        return
      }
      await authorize(target ?? address!)
    } catch (error) {
      runner.setError(isPasskeyCancel(error) ? PASSKEY_CANCELLED : errorMessage(error))
    } finally {
      setReauthBusy(false)
    }
  }

  const wallets = eligibleWallets(state)
  return (
    <div className="gc-stack">
      <p>Authorize <code>{shortId(address)}</code> to withdraw this workspace's funds and claim its ANTS rewards. It will be the only wallet able to transfer or remove the role later.</p>
      {wallets.length > 0 && (
        <ul className="gc-fineprint">
          {wallets.map((wallet) => (
            <li key={wallet.address}><code>{shortId(wallet.address)}</code> {wallet.ready ? 'can be authorized' : `can be authorized from ${formatDateTime(wallet.eligibleAt)}`}{sameAddress(wallet.address, address) ? ' (connected)' : ''}</li>
          ))}
        </ul>
      )}
      {blocker && <Alert tone="warning">{blocker}</Alert>}
      {reauth && (
        <Alert tone="info" title="Confirm it is you">
          <div className="gc-stack gc-stack--tight">
            <span>{reauth === 'other'
              ? `Confirm with a different sign-in method than ${shortId(target ?? address)}, the wallet you are authorizing: a passkey, or another of your wallets (connect it, confirm, then switch back).`
              : 'Authorizing a withdrawal wallet needs a fresh sign-in.'}</span>
            <div className="gc-inline gc-inline--wrap">
              <Button size="sm" disabled={reauthBusy} onClick={() => void signInAgain('passkey')}>Confirm with a passkey</Button>
              <Button size="sm" variant="outline" disabled={reauthBusy} onClick={() => void signInAgain('wallet')}>{reauthBusy ? 'Check your wallet…' : `Confirm with ${shortId(address)}`}</Button>
            </div>
          </div>
        </Alert>
      )}
      <TxFeedback chain={chain} runner={runner} done="Wallet authorized." />
      <Button fullWidth disabled={runner.running || reauthBusy || !!blocker} onClick={() => void authorize(address)}>{runner.running ? 'Working…' : 'Authorize this wallet'}</Button>
      <p className="gc-fineprint">You will sign in again, then confirm one transaction from this wallet (it pays the network fee in ETH on {chain.name}).</p>
    </div>
  )
}

/** The connected wallet is the operator: transferOperator to another wallet, or to the zero address to remove it. */
function Manage({ workspaceId, state, chain, onChanged, onStale }: OperatorActionsProps) {
  const { address } = useAccount()
  const config = useConfig()
  const runner = useTxRunner(chain.chainId)
  const { writeContractAsync } = useWriteContract()
  const live = useLiveOperator(chain)
  const [next, setNext] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirming, setConfirming] = useState<'transfer' | 'clear' | null>(null)
  const deposits = contractAddress(chain, 'deposits')
  const view = operatorView(state, address)
  if (!deposits) return <Alert tone="warning">The gateway did not report the deposits contract address.</Alert>
  if (!address) return <Connect label={`Connect ${shortId(state.operator)} to manage it`} />
  if (!view.canManage) return <Alert tone="warning">{view.manageHint ?? 'Only the authorized wallet can transfer or remove the role.'}</Alert>

  const trimmed = next.trim()
  const valid = /^0x[0-9a-fA-F]{40}$/.test(trimmed) && !sameAddress(trimmed, ZERO_ADDRESS)
  const known = state.eligibleWallets.some((entry) => sameAddress(entry.address, trimmed))
  const self = sameAddress(trimmed, state.buyer)

  async function transfer(to: string) {
    setConfirming(null)
    const hash = await runner.run([{
      label: to === ZERO_ADDRESS ? 'Remove authorized wallet' : 'Transfer authorization',
      check: async () => {
        const current = await live(state.buyer)
        if (!sameAddress(current.operator, address)) throw new OperatorPreflightError(`The authorized wallet is now ${current.operator ? shortId(current.operator) : 'not set'}, not the connected wallet. The panel now shows it.`, true)
        await simulateContract(config, { account: address as Hex, address: deposits!, abi: DEPOSITS_OPERATOR_ABI, functionName: 'transferOperator', args: [state.buyer as Hex, to as Hex], chainId: chain.chainId })
      },
      send: () => writeContractAsync({ address: deposits!, abi: DEPOSITS_OPERATOR_ABI, functionName: 'transferOperator', args: [state.buyer as Hex, to as Hex], chainId: chain.chainId }),
    }], { onStale })
    if (hash) {
      setNext('')
      setAcknowledged(false)
      onChanged(await syncExpecting(workspaceId, hash, to === ZERO_ADDRESS ? null : to))
    }
  }

  return (
    <div className="gc-stack">
      <p>The connected wallet is the authorized wallet. You can hand the role to another wallet or remove it. Both are immediate and only the new wallet (or, after removal, the organization owner through the gateway) can change it again.</p>
      <TextField label="New authorized wallet" placeholder="0x…" value={next} onChange={(event) => { setNext(event.target.value); setAcknowledged(false) }}
        error={next && !valid ? 'Enter a 0x wallet address.' : self ? 'That is the workspace wallet itself; the gateway CLI handles that case.' : undefined} />
      {valid && !self && !known && (
        <label className="gc-inline">
          <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>{shortId(trimmed)} is not one of your sign-in wallets. I control it, or trust whoever does with this workspace's withdrawals and rewards.</span>
        </label>
      )}
      <TxFeedback chain={chain} runner={runner} done="Authorized wallet updated." />
      <div className="gc-inline gc-inline--wrap">
        <Button disabled={runner.running || !valid || self || (!known && !acknowledged)} onClick={() => setConfirming('transfer')}>Transfer authorization</Button>
        <Button variant="outline" disabled={runner.running} onClick={() => setConfirming('clear')}>Remove authorized wallet</Button>
      </div>
      <ConfirmDialog isOpen={confirming !== null} onClose={() => setConfirming(null)} tone="danger"
        title={confirming === 'clear' ? 'Remove the authorized wallet?' : `Transfer to ${shortId(trimmed)}?`}
        confirmLabel={confirming === 'clear' ? 'Remove' : 'Transfer'}
        body={confirming === 'clear'
          ? 'Nobody will be able to withdraw or claim rewards until the organization owner authorizes a wallet again through the gateway. Requests keep working.'
          : `${shortId(trimmed)} will receive all future withdrawals and ANTS rewards, and only it can change this again. Your connected wallet loses the role.`}
        onConfirm={() => void transfer(confirming === 'clear' ? ZERO_ADDRESS : trimmed)} />
    </div>
  )
}

/** Authorize (no operator) or transfer/remove (connected wallet is the operator), with wagmi on the gateway's chain. */
export default function OperatorActions(props: OperatorActionsProps & { mode: 'authorize' | 'manage' }) {
  return (
    <WalletProvider chain={props.chain}>
      <div className="gc-stack">
        <ConnectedWallet />
        {props.mode === 'authorize' ? <Authorize {...props} /> : <Manage {...props} />}
      </div>
    </WalletProvider>
  )
}
