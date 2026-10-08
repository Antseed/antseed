import { useState } from 'react'
import { useAccount, useDisconnect, useSignMessage } from 'wagmi'
import { Alert, Button } from '@antseed/ui'
import { errorMessage } from '../api'
import type { MeResponse } from '../api/types'
import { shortId } from '../lib/format'
import { reauthWithWallet } from '../lib/reauth'
import { ConnectWalletButton } from './ConnectWallet'
import { WalletProvider, walletError } from './provider'

/** Confirms the current session by signing with one of the member's own wallets (POST /auth/reauth/wallet/*). */
function Confirm({ onConfirmed }: { onConfirmed: (me: MeResponse) => void }) {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const { signMessageAsync } = useSignMessage()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!isConnected || !address) {
    return <ConnectWalletButton label="Connect your wallet" size="sm" variant="outline" fullWidth={false} />
  }
  return (
    <div className="gc-stack gc-stack--tight">
      <div className="gc-inline gc-inline--wrap">
        <Button size="sm" disabled={busy} onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            onConfirmed(await reauthWithWallet(address, async (message) => {
              try { return await signMessageAsync({ message }) } catch (cause) { throw new Error(walletError(cause, 'Signing was cancelled.')) }
            }))
          } catch (cause) {
            setError(errorMessage(cause))
          } finally {
            setBusy(false)
          }
        }}>{busy ? 'Check your wallet…' : `Confirm with ${shortId(address)}`}</Button>
        <Button size="sm" variant="ghost" onClick={() => disconnect()}>Use a different wallet</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  )
}

export default function WalletConfirm(props: { onConfirmed: (me: MeResponse) => void }) {
  return <WalletProvider chain={null}><Confirm {...props} /></WalletProvider>
}
