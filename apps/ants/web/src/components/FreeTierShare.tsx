import { useState } from 'react';
import { isAddress } from 'viem';
import { useSignTypedData } from 'wagmi';
import { api } from '../api';
import { useApp } from '../app-context';
import { describeError } from '../format';
import { useWalletReadiness } from '../wallet-readiness';
import { CopyButton } from './AddressLink';
import { Field, Input, Select } from './Field';
import { Panel } from './Panel';
import { Button } from './ui';

const DAY = 86_400;
const VALIDITY_DAYS = [30, 90, 365];

/** Matches FREE_TIER_DELEGATION_TYPES in @antseed/node. */
const DELEGATION_TYPES = {
  FreeTierDelegation: [
    { name: 'staker', type: 'address' },
    { name: 'buyer', type: 'address' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

interface SharedCode {
  code: string;
  buyer: string;
  expiresAt: number;
}

type Sign = (buyer: string, expiresAt: number) => Promise<string | undefined>;

/**
 * Lets a staker share its staking power with a buyer: the staker signs once
 * and copies a code, and the buyer pastes it into its node. Sellers with a
 * staked free tier then count this wallet's positions toward that buyer.
 */
export function FreeTierShare() {
  const { config } = useApp();
  // Until a browser wallet is connected there is nothing to sign with; the form stays disabled.
  return config.browserWallet && !config.readOnly ? <BrowserWalletShare /> : <FreeTierShareForm sign={async () => undefined} />;
}

function BrowserWalletShare() {
  const { config } = useApp();
  const { signTypedDataAsync } = useSignTypedData();
  const sign: Sign = (buyer, expiresAt) => signTypedDataAsync({
    domain: { name: 'AntseedFreeTier', version: '1', chainId: config.evmChainId },
    types: DELEGATION_TYPES,
    primaryType: 'FreeTierDelegation',
    message: { staker: config.address as `0x${string}`, buyer: buyer as `0x${string}`, expiresAt: BigInt(expiresAt) },
  });
  return <FreeTierShareForm sign={sign} />;
}

/** `sign` returns the browser wallet's signature, or undefined when the dashboard's own key signs on the server. */
function FreeTierShareForm({ sign }: { sign: Sign }) {
  const { config } = useApp();
  const readiness = useWalletReadiness();
  const [buyer, setBuyer] = useState('');
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState<SharedCode | null>(null);
  const notReady = readiness?.reason ?? (config.readOnly ? 'Connect your staking wallet to sign.' : undefined);
  const validBuyer = isAddress(buyer.trim());
  const until = new Date(Date.now() + days * DAY * 1000).toLocaleDateString();

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const target = buyer.trim();
      const expiresAt = Math.floor(Date.now() / 1000) + days * DAY;
      const signature = await sign(target, expiresAt);
      setShared(await api.freeTierCode({ buyer: target, expiresAt, signature }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Share free tier">
      <div className="stack">
        <div className="hint">
          Sellers with a staked free tier raise a buyer's free limit by the staking power in their own pool, and some offer models free only to their stakers. Create a code for a buyer address and send it to them: on each seller, your positions in that seller's pool then count for that buyer.
          Signing costs no gas and moves no ANTS.
        </div>
        <div className="hint">
          Positions you transfer stop counting for the buyer. Every buyer you share with draws from the same allowance. Power drops each week as a lock runs down; max lock keeps it.
        </div>
        {shared ? (
          <div className="stack">
            <div className="free-tier-code">
              <code>{shared.code}</code>
              <CopyButton value={shared.code} />
            </div>
            <div className="hint">
              For buyer <code>{shared.buyer}</code>, valid until {new Date(shared.expiresAt * 1000).toLocaleDateString()}. The buyer pastes it under <strong>Staked free tier</strong> on Rewards in the desktop app or on Staking in the gateway console, or runs{' '}
              <code>antseed buyer free-tier add &lt;code&gt;</code>.
            </div>
            <div className="row">
              <Button variant="outline" size="sm" onClick={() => { setShared(null); setBuyer(''); }}>Share with another buyer</Button>
            </div>
          </div>
        ) : (
          <div className="form-row">
            <Input
              label="Buyer address"
              placeholder="0x…"
              width="lg"
              value={buyer}
              onChange={(e) => setBuyer(e.target.value)}
              error={buyer && !validBuyer ? 'Enter a 0x address.' : undefined}
            />
            <Field label="Valid for" width="sm">
              <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {VALIDITY_DAYS.map((d) => <option key={d} value={d}>{d} days</option>)}
              </Select>
            </Field>
            <Button onClick={() => void create()} disabled={busy || !validBuyer || !!notReady} title={notReady}>
              {busy ? 'Waiting for signature…' : 'Sign and create code'}
            </Button>
          </div>
        )}
        {shared ? null : (
          <div className="hint">Shares all your stake in each seller's pool, now and later, until {until}.</div>
        )}
        {error ? <div className="error-text">{error}</div> : null}
      </div>
    </Panel>
  );
}
