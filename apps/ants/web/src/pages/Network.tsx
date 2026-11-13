import { useEffect, useRef, type ReactNode } from 'react';
import type { NetworkSnapshot } from '../../../src/api-types';
import { api } from '../api';
import { AddressLink } from '../components/AddressLink';
import { Details } from '../components/Details';
import { EmissionsSection, networkAnts } from '../components/EmissionsSection';
import { ErrorBox, Skeleton } from '../components/Feedback';
import { Facts, Panel } from '../components/Panel';
import { StatTile, Tiles } from '../components/StatTile';
import { UsageSection } from '../components/UsageSection';
import { VerificationRegistry } from '../components/Verification';
import { Button } from '../components/ui';
import { usePageData } from '../data';
import { formatAnts, formatDuration, formatUtc } from '../format';
import { useNow } from '../hooks';

export function NetworkPage() {
  const page = usePageData('network', api.network, 20_000);
  const { data, refresh } = page;
  const now = useNow(1000);
  const boundaryRef = useRef<number | null>(null);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') refresh(); };
    const timer = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [refresh]);
  useEffect(() => {
    if (!data || boundaryRef.current === data.epoch.current) return;
    const delay = Math.max(1000, data.epoch.secondsToBoundary * 1000 - (Date.now() - data.fetchedAt));
    const timer = window.setTimeout(() => {
      boundaryRef.current = data.epoch.current;
      if (document.visibilityState === 'visible') refresh();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [data, refresh]);
  const stale = !!data && (!!page.error || now - data.fetchedAt > 90_000);
  return <>
    <div className="row"><h1 className="page-title">Network</h1><Button variant="outline" size="sm" onClick={refresh} disabled={page.loading}>Refresh network</Button></div>
    {page.error && !data ? <ErrorBox error={page.error} onRetry={refresh} /> : null}
    {!data && page.loading ? <Skeleton rows={5} /> : null}
    {data && <>
      <p className="hint">{data.evmChainId === 31337 ? 'Local Anvil · test-chain data, not live production' : `${data.chainId} · chain ${data.evmChainId}`} · block {data.blockNumber} · {formatUtc(data.blockTimestamp)}</p>
      {data.activation !== 'active' && <p className="status-line">{data.activation === 'not-active' ? 'The configured reward stack is not the registry’s active stack. These are its configured allowances, not a claim of active reward distribution.' : 'Registry activation could not be verified.'}</p>}
      {data.epoch.effective !== null && data.epoch.current < data.epoch.effective && <p className="hint">Recognized-usage rewards start at epoch {data.epoch.effective}. The current epoch is before reward activation.</p>}
      {stale && <p className="status-line" role="status">Stale network snapshot. {page.error ?? 'Refresh to read the latest contract state.'}</p>}
      {data.errors.length > 0 && <div className="status-line" role="status">Some contract reads are unavailable: {data.errors.join(' ')}</div>}
      <NetworkSummary data={data} now={now} />
      <EmissionsSection data={data} />
      <Panel><Details summary="Emission schedule and contract details">
        <Facts items={[
          ['First recognized-usage reward epoch', data.epoch.effective ?? 'Unavailable'],
          ['Epoch length', formatDuration(data.epoch.epochDuration)],
          ['Genesis', formatUtc(data.epoch.genesis)],
          ['Initial scheduled emission', networkAnts(data.initialEmission)],
          ['Halving interval', `${data.halvingInterval} epochs`],
          ['Scheduled cumulative emission through this epoch', networkAnts(data.cumulativeScheduled)],
          ['Total active stake', networkAnts(data.totalActiveStake)],
          ['Total power weight', data.totalPowerWeight === null ? 'Unavailable' : formatAnts(data.totalPowerWeight)],
          ...Object.entries(data.contracts).map(([name, address]) => [name, <AddressLink value={address} short={false} />] as [string, ReactNode]),
        ]} />
        <p className="hint">Scheduled emission is an allowance, not a minted-token counter. Current supply is read separately from the token contract. All main network figures use the same snapshot block.</p>
      </Details></Panel>
    </>}
    <Panel><Details summary="Your usage history and network comparisons" lazy><UsageSection /></Details></Panel>
    <Panel><Details summary="Legacy emissions" lazy><LegacyNetwork /></Details></Panel>
    <Panel><Details summary="Verification registry" lazy><NetworkVerification /></Details></Panel>
  </>;
}

function NetworkSummary({ data, now }: { data: NetworkSnapshot; now: number }) {
  const remaining = Math.max(0, data.epoch.secondsToBoundary - Math.floor((now - data.fetchedAt) / 1000));
  return <Tiles>
    <StatTile label="Current epoch" value={data.epoch.current} sub={formatUtc(data.epoch.genesis + data.epoch.current * data.epoch.epochDuration)} />
    <StatTile label="Next epoch starts in" value={remaining > 0 ? formatDuration(remaining) : 'Awaiting chain update'} sub={formatUtc(data.epoch.nextBoundaryAt)} />
    <StatTile label="Scheduled epoch emission · ANTS" value={data.emission === null ? 'Unavailable' : formatAnts(data.emission)} sub="Allowance, not tokens already minted" />
    <StatTile label="Current token supply · ANTS" value={data.totalSupply === null ? 'Unavailable' : formatAnts(data.totalSupply)} sub={`Maximum supply: ${networkAnts(data.maxSupply)}`} />
  </Tiles>;
}

function LegacyNetwork() {
  const page = usePageData('network:legacy', api.networkLegacy, 300_000);
  if (page.error) return <ErrorBox error={page.error} onRetry={page.refresh} />;
  if (page.loading && !page.data) return <Skeleton rows={2} />;
  const data = page.data;
  return data ? <><Facts items={[
    ['Legacy contract', <AddressLink value={data.contract} />],
    ['Legacy epoch', data.currentEpoch],
    ['Legacy configured split', `Sellers ${data.sellerPct}% · buyers ${data.buyerPct}% · reserve ${data.reservePct}% · team ${data.teamPct}%`],
  ]} /><p className="hint">Historical reward-system configuration. These percentages do not describe the current recognized-usage reward budgets.</p></> : <p className="muted">No legacy emissions contract configured.</p>;
}

function NetworkVerification() {
  const page = usePageData('verification:own', () => api.verification(), 300_000);
  if (page.error) return <ErrorBox error={page.error} onRetry={page.refresh} />;
  return page.data ? <VerificationRegistry data={page.data} /> : <Skeleton rows={3} />;
}
