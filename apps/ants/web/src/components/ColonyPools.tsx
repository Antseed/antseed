import { useState } from 'react';
import type { WorkerPayoutLinkRequest, ColonyPoolClaimRequest, ColonyPoolsView } from '../../../src/api-types';
import { api } from '../api';
import { useConfig } from '../app-context';
import { usePageData } from '../data';
import { formatAnts, formatUsdc, isZero } from '../format';
import { AddressLink } from './AddressLink';
import { ActionButton } from './Confirm';
import { Input } from './Field';
import { Card } from './ui';

/**
 * Earnings from Macs this wallet is the payout address for (Antseed Mac app),
 * and linking a new Mac with the code the app copies.
 */
export function ColonyPoolsCard({ stale = false }: { stale?: boolean }) {
  const dashboard = useConfig();
  const page = usePageData('colony-pools', api.colonyPools, 5 * 60_000);
  const [code, setCode] = useState('');
  const [linking, setLinking] = useState(false);
  const pools: ColonyPoolsView['pools'] = page.data?.pools ?? [];
  const linkBody: WorkerPayoutLinkRequest = { code: code.trim() };
  // Same rule as the rest of the Rewards page: no actions while amounts refresh,
  // or while they may be out of date because the last refresh failed.
  const refreshing = stale || page.reconciling || !!page.error;
  const refreshReason = page.error ? 'Mac earnings could not be refreshed. Retry first.' : 'Wait for rewards to refresh before another action.';

  // Not read yet: no answer is not the same as no Macs.
  if (!page.data && !page.error) return null;
  // Never read: say so, rather than suggest this wallet has no Macs.
  if (!page.data) {
    return (
      <p className="notice-line" role="status">
        <span>Mac earnings could not be loaded. <button className="link-button" onClick={page.refresh}>Retry</button></span>
      </p>
    );
  }

  // Most wallets run no Mac: keep the page as it is until one does.
  if (pools.length === 0 && !linking) {
    return <p className="hint">Running the Antseed Mac app? <button className="link-button" onClick={() => setLinking(true)}>Link a Mac</button> to receive its earnings here.</p>;
  }

  return (
    <Card className="hero" aria-label="Mac earnings">
      <div className="tile-label">Mac earnings</div>
      <p className="hint">USDC and ANTS that colony pools owe <AddressLink value={dashboard.address} /> for Macs that pay out here.</p>
      {page.error ? (
        <p className="notice-line" role="status">
          <span>Could not refresh these amounts; they may be out of date. <button className="link-button" onClick={page.refresh}>Retry</button></span>
        </p>
      ) : null}
      {pools.map((pool) => {
        const claim = (usdc: boolean, ants: boolean): ColonyPoolClaimRequest => ({ pool: pool.address, usdc, ants });
        // Unfunded epochs may still owe ANTS: claiming pulls their emissions into the pool first.
        const nothing = isZero(pool.usdcOwed) && isZero(pool.antsOwed) && pool.unfundedEpochs.length === 0;
        return (
          <div className="bucket" key={pool.address}>
            <div className="bucket-main">
              <div className="bucket-name">Colony pool <AddressLink value={pool.address} /></div>
            </div>
            <div className="bucket-amount mono bucket-amount--detailed">
              <span>{formatUsdc(pool.usdcOwed, 6)} <span className="unit">USDC</span></span>
              <span className="bucket-amount-detail">{formatAnts(pool.antsOwed, 4)} ANTS{pool.unfundedEpochs.length > 0 ? ' + unclaimed epochs' : ''}</span>
            </div>
            <div className="bucket-actions">
              <ActionButton
                label="Claim to wallet"
                size="sm"
                title="Claim Mac earnings"
                path="/api/colony-pools/claim"
                body={claim(true, true)}
                disabled={refreshing || nothing}
                disabledReason={refreshing ? refreshReason : 'Nothing to claim.'}
              />
            </div>
          </div>
        );
      })}
      <div className="hero-actions">
        <Input label="Link a Mac" placeholder="antseed-link:…" value={code} onChange={(event) => setCode(event.target.value)} width="lg"
          hint="In the Antseed Mac app, enter this wallet and press Link, then paste the code here." />
        <ActionButton
          label="Link Mac"
          size="sm"
          title="Pay this Mac's earnings to this wallet"
          path="/api/colony-pools/link"
          body={linkBody}
          disabled={refreshing}
          disabledReason={refreshReason}
          validate={() => (code.trim().startsWith('antseed-link:') ? null : 'Paste the code from the Antseed Mac app.')}
        />
      </div>
    </Card>
  );
}
