import { ConnectButton } from '@rainbow-me/rainbowkit'
import { Button, type ButtonProps } from '@antseed/ui'

/**
 * The single "connect" action of a wallet flow: the console's own Button
 * opening RainbowKit's picker (never RainbowKit's default button).
 */
export function ConnectWalletButton({ label = 'Connect wallet', fullWidth = true, size, variant }: {
  label?: string; fullWidth?: boolean; size?: ButtonProps['size']; variant?: ButtonProps['variant']
}) {
  return (
    <ConnectButton.Custom>
      {({ openConnectModal, mounted }) => (
        <Button fullWidth={fullWidth} size={size} variant={variant} disabled={!mounted} onClick={openConnectModal}>{label}</Button>
      )}
    </ConnectButton.Custom>
  )
}

/**
 * One quiet line once a wallet is connected: which one, a network switch
 * when it is on the wrong chain, and a way to change it. Renders nothing
 * while disconnected; the flow below shows its own connect button.
 */
export function ConnectedWallet() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openAccountModal, openChainModal }) => {
        if (!mounted || !account || !chain) return null
        return (
          <div className="gc-connected">
            <span className="gc-connected__dot" aria-hidden="true" />
            <span>Connected <code className="gc-mono">{account.displayName}</code></span>
            {chain.unsupported && (
              <>
                <span aria-hidden="true">·</span>
                <span className="gc-warn">Wrong network</span>
                <Button variant="link" size="sm" onClick={openChainModal}>Switch network</Button>
              </>
            )}
            <span aria-hidden="true">·</span>
            <Button variant="link" size="sm" onClick={openAccountModal}>Change</Button>
          </div>
        )
      }}
    </ConnectButton.Custom>
  )
}
