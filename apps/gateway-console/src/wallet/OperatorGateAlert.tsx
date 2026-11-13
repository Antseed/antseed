import { Alert, Button } from '@antseed/ui'
import { shortId } from '../lib/format'
import type { Gate, OperatorState } from '../lib/operator'
import { navigate } from '../lib/router'
import { ConnectWalletButton } from './ConnectWallet'

/**
 * Why an authorized-wallet action (withdraw, claim, close on chain) is not
 * available yet, with the next step as a button: connect the authorized
 * wallet, or authorize one when none is set and the viewer may. Without
 * `onAuthorize` it goes to the Wallet page, where the authorize flow lives.
 */
export function OperatorGateAlert({ gate, state, connected, onAuthorize }: {
  gate: Gate
  state: OperatorState | undefined
  connected: string | undefined
  onAuthorize?: () => void
}) {
  return (
    <div className="gc-stack">
      <Alert tone={gate.operator ? 'warning' : 'info'} title={gate.operator ? 'Use the authorized wallet' : 'No authorized wallet'}>{gate.reason}</Alert>
      {gate.operator && !connected && <ConnectWalletButton label={`Connect ${shortId(gate.operator)}`} />}
      {!gate.operator && state?.canAuthorize && (
        <Button fullWidth onClick={onAuthorize ?? (() => navigate('wallet'))}>Authorize a wallet</Button>
      )}
    </div>
  )
}
