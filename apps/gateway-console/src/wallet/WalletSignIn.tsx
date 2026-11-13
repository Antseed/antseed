import { useEffect, useRef, useState } from 'react'
import { useAccount, useDisconnect, useSignMessage } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Alert, Button } from '@antseed/ui'
import { api, errorMessage } from '../api'
import type { MeResponse } from '../api/types'
import { shortId } from '../lib/format'
import { WalletProvider, walletError } from './provider'

interface Props {
  enrollment?: string
  onSignedIn: (me: MeResponse) => void
  /** Open the wallet picker as soon as it is ready (the user already chose this method). */
  autoConnect?: boolean
  /** Button text once a wallet is connected; default "Sign in as …". */
  actionLabel?: (address: string) => string
  /** Return true when the caller handled the error (e.g. 403 reauth_required while adding a wallet). */
  onError?: (error: unknown) => boolean
}

/** Calls `open` once, the first time `ready` is true. */
function AutoOpen({ ready, open }: { ready: boolean; open: () => void }) {
  const done = useRef(false)
  useEffect(() => {
    if (ready && !done.current) {
      done.current = true
      open()
    }
  }, [ready, open])
  return null
}

function SignIn({ enrollment, onSignedIn, autoConnect, actionLabel, onError }: Props) {
  const { address, isConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const { signMessageAsync } = useSignMessage()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const signLabel = actionLabel ? actionLabel(shortId(address)) : `Sign in as ${shortId(address)}`

  async function sign() {
    if (!address) return
    setBusy(true)
    setError(null)
    try {
      const { message } = await api.auth.walletNonce(address)
      let signature: string
      try {
        signature = await signMessageAsync({ message })
      } catch (cause) {
        throw new Error(walletError(cause, 'Signing was cancelled.'))
      }
      onSignedIn(await api.auth.walletVerify(message, signature, enrollment))
    } catch (cause) {
      if (!onError?.(cause)) setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gc-stack">
      {!isConnected || !address ? (
        <ConnectButton.Custom>
          {({ openConnectModal, mounted }) => (
            <>
              {autoConnect && <AutoOpen ready={mounted} open={openConnectModal} />}
              <Button variant="outline" fullWidth disabled={!mounted} onClick={openConnectModal}>Connect a wallet</Button>
            </>
          )}
        </ConnectButton.Custom>
      ) : (
        <>
          <Button variant="outline" fullWidth disabled={busy} onClick={() => void sign()}>
            {busy ? 'Check your wallet…' : signLabel}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => disconnect()}>Use a different wallet</Button>
        </>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  )
}

/** Sign-In with Ethereum (EIP-4361): connect, sign the gateway's nonce message, get a session. */
export default function WalletSignIn(props: Props) {
  return <WalletProvider chain={null}><SignIn {...props} /></WalletProvider>
}
