import { useEffect, useState } from 'react';
import { useAccount, useSignTypedData } from 'wagmi';
import { Button } from '@antseed/ui';
import type { PaymentConfig } from '../types';
import { getFreeTierDelegations, saveFreeTierDelegation, type FreeTierDelegationsInfo } from '../api';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { truncateAddress } from '../utils/format';
import { ConnectWalletAction } from './ConnectWalletAction';

interface PayShareFreeTierProps {
  config: PaymentConfig | null;
  onShared: () => void;
}

const DAY_SECONDS = 86_400;

/**
 * The connected wallet signs a free-tier delegation to this buyer: its
 * seller-pool stake then counts toward the buyer's staked free tier on
 * every seller it is staked on. Signing costs no gas and moves no funds.
 */
export function PayShareFreeTier({ config, onShared }: PayShareFreeTierProps) {
  const { address, isConnected } = useAccount();
  const walletConnected = isConnected && Boolean(address);
  const { ensureCorrectNetwork } = usePaymentNetwork(config);
  const { signTypedDataAsync } = useSignTypedData();
  const [info, setInfo] = useState<FreeTierDelegationsInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getFreeTierDelegations().then(setInfo).catch((err) => setError(getErrorMessage(err)));
  }, []);

  const existing = info?.delegations.find((entry) => entry.staker.toLowerCase() === address?.toLowerCase());

  const share = async () => {
    if (!address || !info) return;
    setError(null);
    setRunning(true);
    try {
      await ensureCorrectNetwork();
      const expiresAt = Math.floor(Date.now() / 1000) + info.defaultDays * DAY_SECONDS;
      const signature = await signTypedDataAsync({
        domain: info.domain,
        types: info.types,
        primaryType: 'FreeTierDelegation',
        message: { staker: address, buyer: info.buyer as `0x${string}`, expiresAt: BigInt(expiresAt) },
      });
      await saveFreeTierDelegation({ staker: address, expiresAt, signature });
      onShared();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not share your free tier.'));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="pay-checkout-authorize">
      {!walletConnected ? (
        <ConnectWalletAction>
          {({ openConnectModal, ready, connected }) => connected ? null : (
            <Button fullWidth onClick={openConnectModal} disabled={!ready}>Connect staking wallet</Button>
          )}
        </ConnectWalletAction>
      ) : (
        <>
          <p className="pay-checkout-subtitle">
            Signing from <code>{truncateAddress(address!)}</code>. No gas, no funds move.
            {existing ? ` This wallet already shares until ${new Date(existing.expiresAt * 1000).toLocaleDateString()}; signing again renews it.` : ''}
          </p>
          <Button fullWidth onClick={() => void share()} disabled={running || !info}>
            {running ? 'Waiting for signature…' : `Share for ${info?.defaultDays ?? 90} days`}
          </Button>
        </>
      )}
      {error && <div role="alert" className="status-msg status-error">{error}</div>}
    </div>
  );
}
