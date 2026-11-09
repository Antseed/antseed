import { Button, Card } from '../components/ui';
import { useContext, useEffect, useState } from 'react';
import type { ClaimRequest, CreatedInviteView, InviteAllowanceView, PoolView, ReferralView, ReferredBuyerView, RestakeRequest, RewardBucket, RewardsView, StakeUsageRequest } from '../../../src/api-types';
import { copyText } from '@antseed/ui';
import { BROWSER_WALLET_INVITE_MESSAGE, inviteAllowance, NO_INVITE_QUOTA_MESSAGE } from '../../../src/invite-allowance';
import { request, api } from '../api';
import { BuyerWalletAction } from '../wallet';
import { useConfig, useEpochInfo } from '../app-context';
import { AddressLink } from '../components/AddressLink';
import { ActionButton } from '../components/Confirm';
import { ErrorBox, Skeleton } from '../components/Feedback';
import { Table, type Column } from '../components/Table';
import { Field, Select } from '../components/Field';
import { LockSlider } from '../components/LockSlider';
import { poolName } from '../components/Pools';
import { usePageData } from '../data';
import { host } from '../host';
import { poolDataOptions } from '../pool-data';
import { formatAnts, formatInt, isZero, sumBig, toBigInt } from '../format';
import { BuildersCard } from './BuildersCard';
import { BucketRow, RewardAmount, RewardRefreshContext, RewardRefreshStatus } from './reward-rows';

export function RewardsPage() {
  const page = usePageData('rewards', api.rewards, 5 * 60_000);
  const data = page.data;
  const updating = page.reconciling && (!page.error || page.loading);
  const stale = !!data && (page.reconciling || !!page.error);
  return (
    <>
      {page.error && !data ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {page.error && data && !page.loading ? <ErrorBox title="Rewards could not be refreshed" error={`Shown amounts may be out of date. Retry refreshing before another action. This does not mean a confirmed transaction failed. ${page.error}`} onRetry={page.refresh} /> : null}
      {updating ? <p role="status" className="hint">Updating… Waiting for the latest reward data.</p> : null}
      {!data && page.loading ? (
        <>
          <div className="muted small mb">Loading rewards from the blockchain and indexer…</div>
          <Skeleton rows={6} />
        </>
      ) : null}
      {data ? <RewardRefreshContext.Provider value={{ updating, stale }}>
        {host().buyerRewards ? <BuyerRewardsCard data={data} /> : null}
        {data.scope !== 'buyer' ? <RewardsBody onRefresh={page.refresh} data={data} />
          : host().buyerRewards ? null : <p className="hint">Connect the wallet that holds your staking positions to see its staking rewards.</p>}
        {data.scope !== 'buyer' ? <ReferralRewardsCard operator={data.buyerUsage.operator} /> : null}
        {data.scope !== 'buyer' ? <BuildersCard /> : null}
      </RewardRefreshContext.Provider> : null}
    </>
  );
}

/** `https://antseed.com/invite/<91 chars>` → `antseed.com/invite/AbCdEf…wXyZ`; Copy still copies the full link. */
function shortInviteLink(link: string): string {
  const match = /^https?:\/\/(.*\/invite\/)([A-Za-z0-9_-]+)$/.exec(link);
  return match ? `${match[1]}${match[2]!.slice(0, 6)}…${match[2]!.slice(-4)}` : link;
}

/** Whether this session can act for the buyer account: the contract accepts only its operator. */
function isBuyerOperator(dashboard: ReturnType<typeof useConfig>, operator: string | null | undefined): boolean {
  return !!operator && operator.toLowerCase() === (dashboard.walletAddress ?? dashboard.address).toLowerCase() && !dashboard.readOnly;
}

/** Why a referral claim is off, most actionable first; null when it can be sent. */
function referralClaimBlocked(session: { readOnly?: boolean }, authorized: boolean, payable: string): string | null {
  if (session.readOnly) return 'Connect a wallet with a signer to claim.';
  if (isZero(payable)) return 'Nothing to claim yet.';
  return authorized ? null : 'Connect the authorized wallet for this buyer account.';
}

function ReferralRewardsCard({ operator }: { operator: string | null }) {
  const dashboard = useConfig();
  const page = usePageData('referrals', api.referral, 60_000);
  const view = page.data;
  if (view && !view.available) return null;
  const epochs = view?.claimableEpochs.length ?? 0;
  const blocked = view ? referralClaimBlocked(dashboard, isBuyerOperator(dashboard, operator), view.payable) : null;
  return (
    <Card className="hero" aria-label="Referral rewards">
      <div className="tile-label">Referral rewards</div>
      <p className="hint">Invite new buyers with single-use invites. You earn from their usage, and they get 12 weeks of bonus ANTS.</p>
      {page.error ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {view ? <>
        <div className="hero-value"><RewardAmount>{formatAnts(view.payable, 4)}</RewardAmount><span className="unit">ANTS</span></div>
        <p className="hero-sub muted">Payable now</p>
        <div className="buckets">
          <InviteRow view={view} onCreated={page.refresh} />
          <BucketRow visible name="Payable now" amount={view.payable}
            amountDetail={`${formatInt(view.referredCount)} ${view.referredCount === 1 ? 'referred buyer' : 'referred buyers'}`}
            note={epochs > 0 ? `${epochs} ${epochs === 1 ? 'week is' : 'weeks are'} ready to claim.` : 'Weeks become claimable once they end.'}
            actions={<ActionButton label="Claim" title="Claim referral rewards" path="/api/referrals/claim" body={{}}
              disabled={!!blocked}
              disabledReason={blocked ?? undefined}
              summary={[['Payable now', `${formatAnts(view.payable, 4)} ANTS`], ['Weeks', String(epochs)]]} />} />
        </div>
        <ReferredBuyersTable />
      </> : null}
    </Card>
  );
}

/**
 * Why Create invite is off. `blocked` means this session cannot sign at all.
 * `exhausted` comes from the explorer allowance, which can lag a new week, so
 * it is advisory: the row keeps a "Check again" link that asks the server,
 * which reads the epoch and quota on-chain before signing.
 */
export function inviteRowState(session: { readOnly?: boolean; browserWallet?: boolean }, quota: number | null, left: number | null): { blocked: string | null; exhausted: string | null } {
  const blocked = session.readOnly ? 'Connect a wallet with a signer to create invites.'
    : session.browserWallet ? BROWSER_WALLET_INVITE_MESSAGE : null;
  const exhausted = quota === 0 ? NO_INVITE_QUOTA_MESSAGE
    : left === 0 ? 'All invites for this week are taken. More unlock next week.' : null;
  return { blocked, exhausted: blocked ? null : exhausted };
}

/** A failed create only describes the week it was tried in; a newer allowance clears it. */
export function inviteErrorFor(error: { message: string; epoch: number | null } | null, invites: InviteAllowanceView | null): string | null {
  if (!error) return null;
  return invites && error.epoch !== null && invites.epoch > error.epoch ? null : error.message;
}

/** Create a single-use invite link (signed off-chain by the dashboard wallet) and show what is left this week. */
function InviteRow({ view, onCreated }: { view: ReferralView; onCreated: () => void }) {
  const dashboard = useConfig();
  const [created, setCreated] = useState<CreatedInviteView | null>(null);
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<{ message: string; epoch: number | null } | null>(null);
  const { quota, left } = inviteAllowance(view.invites, created);
  const { blocked, exhausted } = inviteRowState(dashboard, quota, left);
  const error = inviteErrorFor(failure, view.invites);
  const create = async () => {
    const epoch = view.invites?.epoch ?? null;
    setCreating(true); setFailure(null);
    try {
      setCreated(await api.createInvite());
      onCreated(); // re-read the allowance so it does not rest on this snapshot
    } catch (cause) { setFailure({ message: cause instanceof Error ? cause.message : String(cause), epoch }); }
    finally { setCreating(false); }
  };
  // The week may have rolled over on-chain before the allowance shows it; the server decides.
  const recheck = exhausted
    ? <> <button className="link-button" disabled={creating} onClick={() => void create()}>{creating ? 'Checking…' : 'Check again'}</button></>
    : null;
  return (
    <BucketRow visible name="Invites" amount={String(left ?? 0)} amountKind="count"
      amountDetail={quota !== null ? `of ${quota} left this week` : undefined}
      note={error ? <><span role="alert">{error}</span>{recheck}</>
        : created ? <><span className="mono" title={created.link}>{shortInviteLink(created.link)}</span>{recheck}</>
          : exhausted ? <>{exhausted}{recheck}</>
            : blocked ?? 'Each invite works once, for a new buyer, within 4 weeks.'}
      actions={<>
        {created ? <Button variant="outline" size="sm" onClick={() => { void copyText(created.link); }}>Copy</Button> : null}
        <span className="btn-wrap" title={blocked ?? exhausted ?? undefined}>
          <Button variant="outline" size="sm" disabled={!!blocked || !!exhausted || creating} onClick={() => void create()}>{creating ? 'Creating…' : 'Create invite'}</Button>
        </span>
      </>} />
  );
}

/** The buyer account's two-sided invite bonus: weeks left in the window, payable now, and a claim paid to its authorized wallet (operator). */
function RefereeBonusRow({ authorized }: { authorized: boolean }) {
  const dashboard = useConfig();
  const page = usePageData('referrals:referee', api.referee, 60_000);
  const view = page.data;
  if (!view?.available || !view.referrer) return null;
  const epochs = view.claimableEpochs.length;
  if (view.weeksLeft === 0 && isZero(view.payable)) return null;
  const blocked = referralClaimBlocked(dashboard, authorized, view.payable);
  const weeks = view.weeksLeft === null ? null : `${view.weeksLeft} ${view.weeksLeft === 1 ? 'week' : 'weeks'} left`;
  return (
    <BucketRow visible name="Invite bonus" amount={view.payable} amountDetail={weeks ?? undefined}
      note={<>Invited by <AddressLink value={view.referrer} />. Paid to your authorized wallet.</>}
      actions={<ActionButton label="Claim" title="Claim invite bonus" path="/api/referrals/referee/claim" body={{}}
        disabled={!!blocked}
        disabledReason={blocked ?? undefined}
        summary={[['Payable now', `${formatAnts(view.payable, 4)} ANTS`], ['Weeks', String(epochs)]]} />} />
  );
}

const REFERRED_BUYER_COLUMNS: Array<Column<ReferredBuyerView>> = [
  { key: 'buyer', label: 'Buyer', render: (row) => <AddressLink value={row.buyer} /> },
  { key: 'points', label: 'Points', align: 'right', mono: true, title: 'Weighted usage points credited to you for this buyer', render: (row) => formatInt(row.points) },
  { key: 'pending', label: 'Pending', align: 'right', mono: true, title: 'Points from weeks that are not claimable yet; they earn ANTS once the week becomes claimable', render: (row) => isZero(row.pendingPoints) ? '—' : `${formatInt(row.pendingPoints)} pts` },
  { key: 'ants', label: 'Earned', align: 'right', mono: true, title: 'ANTS claimed plus payable now (unlike the headline, which is payable now only)', render: (row) => `${formatAnts(row.ants, 4)} ANTS` },
];

/** Who the wallet referred and what each brought in, from Antscan. */
function ReferredBuyersTable() {
  const page = usePageData('referrals:buyers', api.referredBuyers, 60_000);
  if (page.data && !page.data.available) return null;
  return (
    <div className="mt">
      {page.error ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      <Table columns={REFERRED_BUYER_COLUMNS} rows={page.data?.buyers ?? []} rowKey={(row) => row.buyer}
        loading={page.loading && !page.data} empty="No referred buyers yet." />
    </div>
  );
}

function BuyerRewardsCard({ data }: { data: RewardsView }) {
  const dashboard = useConfig();
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  // The invite bonus is claimed in this card too (its row below), so the headline includes it.
  const referee = usePageData('referrals:referee', api.referee, 60_000).data;
  const inviteBonus = referee?.available && referee.referrer ? referee.payable : '0';
  const amount = sumBig([data.buyerUsage.total, data.legacy.buyer, inviteBonus]);
  const operator = data.buyerUsage.operator;
  const authorized = isBuyerOperator(dashboard, operator);
  const showAuthorization = !operator && dashboard.canAuthorize;
  const showWalletConnection = operator && !authorized && dashboard.browserWallet;
  const stakeUnavailable = isZero(data.buyerUsage.total)
    ? 'No current buyer rewards are available to stake yet.'
    : !authorized
      ? 'Connect the authorized buyer wallet to stake these rewards.'
      : !data.buyerUsage.claimable ? 'These buyer rewards are not currently eligible for direct staking.' : null;
  const config = usePageData(authorized && !isZero(data.buyerUsage.total) ? 'positions:current' : null, api.positions);
  const authorize = async () => {
    setAuthorizing(true); setAuthorizationError(null);
    try { await request('/api/wallet/authorize', { method: 'POST' }); }
    catch (error) { setAuthorizationError(error instanceof Error ? error.message : String(error)); }
    finally { setAuthorizing(false); }
  };
  return <Card className="hero">
    <div className="tile-label">Buyer rewards</div>
    <p className="hint">Earned by buyer account <AddressLink value={dashboard.buyerAddress ?? dashboard.address} />.</p>
    <div className="hero-value"><RewardAmount>{formatAnts(amount, 4)}</RewardAmount><span className="unit">ANTS</span><RewardRefreshStatus /></div>
    {isZero(amount) ? <p className="hero-sub muted">Nothing to claim yet. Rewards accrue at each epoch boundary.</p> : null}
    {!operator ? <p className="hint">Authorize a wallet to claim or stake this buyer’s rewards.</p> : !authorized ? <p className="hint">Connect the authorized wallet <AddressLink value={operator} /> on {dashboard.chainId} to claim or stake.</p> : null}
    {authorized && dashboard.selectedAddress && operator?.toLowerCase() !== dashboard.selectedAddress.toLowerCase() ? <p className="hint">Buyer rewards and positions created by staking them belong to operator <AddressLink value={operator!} />. Select that address to manage those positions.</p> : null}
    {showAuthorization || showWalletConnection ? <div className="hero-actions">
      {showAuthorization ? <button className="btn" disabled={authorizing} onClick={() => void authorize()}>{authorizing ? 'Opening…' : 'Authorize wallet ↗'}</button> : null}
      {showWalletConnection ? <BuyerWalletAction /> : null}
    </div> : null}
    {authorizationError ? <p role="alert" className="hint">{authorizationError}</p> : null}
    <div className="buckets">
      <BucketRow visible name="Current buyer rewards" amount={data.buyerUsage.total}
        note="Earned from using AI services."
        actions={<>
          <ClaimButton bucket="buyer" scope="buyer" amount={data.buyerUsage.total} title="Claim current buyer rewards"
            disabled={!authorized || !data.buyerUsage.claimable} reason="Connect the authorized wallet and check buyer reward eligibility."
            />
          {stakeUnavailable ? <span className="btn-wrap" title={stakeUnavailable}><Button variant="outline" size="sm" disabled>Stake rewards</Button></span>
            : <RestakeButton kind="buyer" data={data} maxEpochs={config.data?.config.maxStakeEpochs ?? null} />}
        </>} />
      <BucketRow visible={!isZero(data.legacy.buyer)} name="Legacy buyer rewards" amount={data.legacy.buyer}
        note="Earned from using AI services under the previous rewards system."
        actions={<ClaimButton bucket="legacy" scope="buyer" amount={data.legacy.buyer} title="Claim legacy buyer rewards"
          disabled={!authorized || !data.legacy.buyerClaimable} reason="Connect the authorized wallet for this buyer account."
          />} />
      <RefereeBonusRow authorized={authorized} />
    </div>
  </Card>;
}

function RewardsBody({ data, onRefresh }: { data: RewardsView; onRefresh: () => void }) {
  const dashboard = useConfig();
  const restakable = data.sellerUsage.claimable ? data.sellerUsage.total : '0';
  const claimableLegacy = data.legacy.seller;
  const sellerTotal = sumBig([data.sellerUsage.total, data.legacy.seller, data.locked.claimable]);
  const otherRewards = sumBig([data.sellerUsage.claimable ? '0' : data.sellerUsage.total, data.legacy.seller, data.locked.claimable]);
  const config = usePageData('positions:current', api.positions);
  const maxEpochs = config.data?.config.maxStakeEpochs ?? null;
  const nothing = isZero(sellerTotal);
  const payout = data.legacy.sellerPayout;
  const payoutKnown = !!payout?.recipient && payout.destination !== 'unknown';
  const payoutLocked = payout?.destination === 'locked';

  return (
    <>
      <Card className="hero" aria-label="Staking rewards">
        {data.historySource === 'chain' ? <p className="status-line status-line--muted">Closed-position history is unavailable. Without an indexer, some rewards may be missing. Refresh to retry.</p> : null}
        {data.historySource === 'local' ? <p className="status-line status-line--muted">Local transaction history included. Older closed positions—and their rewards—may be missing without an indexer.</p> : null}
        <div className="tile-label">Staking rewards</div>
        <p className="hint">Unclaimed staking rewards for <AddressLink value={dashboard.address} />—not your wallet balance.</p>
        <div className="hero-value"><RewardAmount>{formatAnts(data.staker.total, 4)}</RewardAmount><span className="unit">ANTS</span><RewardRefreshStatus /></div>
        {data.staker.source?.indexedBlock !== undefined ? <p className="hint">Estimated by Antscan at block {data.staker.source.indexedBlock}. Claims and restaking are checked live.</p> : null}
        {data.staker.total === null ? <p role="status" className="hint">Staking rewards unavailable: {data.staker.source?.error ?? 'Antscan has not finished indexing these rewards.'} <button className="link-button" onClick={onRefresh}>Retry</button></p> : isZero(data.staker.total) ? <p className="hero-sub muted">Nothing to claim yet. Rewards accrue at each epoch boundary.</p> : (
          <div className="hero-actions">
            <ClaimButton bucket="staker" amount={data.staker.total} />
            <RestakeButton kind="staker" data={data} maxEpochs={maxEpochs} />
          </div>
        )}
      </Card>

      {/* A host without the Seller page shows seller rewards only when there are some. */}
      {!host().pages.includes('seller') && nothing && isZero(data.locked.locked) ? null : <Card className="hero" aria-label="Seller rewards">
        <div className="tile-label">Seller rewards</div>
        <p className="hint">Unclaimed AI selling rewards for <AddressLink value={dashboard.address} />—not your wallet balance.</p>
        <div className="hero-value">
          <RewardAmount>{formatAnts(sellerTotal, 4)}</RewardAmount>
          <span className="unit">ANTS</span>
          <RewardRefreshStatus />
        </div>
        {!nothing ? (
          <div className="hero-sub">
            Available to stake directly <span className="mono"><RewardAmount>{formatAnts(restakable, 4)}</RewardAmount></span> · other rewards <span className="mono"><RewardAmount>{formatAnts(otherRewards, 4)}</RewardAmount></span>
          </div>
        ) : null}
        {nothing ? (
          <div className="hero-sub muted">Nothing to claim yet. Rewards accrue at each epoch boundary.</div>
        ) : null}

      {nothing && isZero(data.locked.locked) ? null : (
        <div className="buckets">
          <BucketRow
            visible={!isZero(data.sellerUsage.total)}
            name="Current seller rewards"
            note="Earned from providing AI services."
            amount={data.sellerUsage.total}
            actions={
              <>
                <ClaimButton bucket="seller" amount={data.sellerUsage.total} disabled={!data.sellerUsage.claimable} reason="Seller usage rewards are not claimable from this wallet." />
                <RestakeButton kind="seller" data={data} maxEpochs={maxEpochs} />
              </>
            }
          />
          <BucketRow
            visible={!isZero(data.legacy.seller)}
            name="Legacy seller rewards"
            note="Earned from providing AI services under the previous rewards system."
            amount={data.legacy.seller}
            actions={<><ClaimButton bucket="legacy" amount={claimableLegacy} title="Claim legacy seller rewards"
              label={!payoutKnown ? 'Claim unavailable' : payoutLocked ? 'Claim not available yet' : 'Claim to wallet'}
              disabled={!payoutKnown || payoutLocked}
              reason={payoutKnown && payoutLocked ? 'Claiming legacy seller rewards into the locked pool is currently unavailable in this dashboard.' : 'Payout destination could not be verified. Refresh rewards before claiming.'}
              expectedLegacySellerRecipient={payout?.recipient ?? undefined}
              />
              {!payoutKnown ? <Button variant="outline" size="sm" onClick={onRefresh}>Refresh rewards</Button> : null}
            </>}
          />
          <BucketRow
            visible={!isZero(data.locked.claimable) || !isZero(data.locked.locked)}
            name="Locked seller rewards"
            note="Past seller rewards held in the locked pool."
            amount={data.locked.claimable}
            amountDetail={`${formatAnts(data.locked.locked, 4)} ANTS locked`}
            actions={<ClaimButton bucket="locked" amount={data.locked.claimable} label="Withdraw available amount" title="Withdraw released seller rewards"
              disabled={!data.locked.policy} reason={!data.locked.policy ? 'M002 (unlock policy) is not installed.' : isZero(data.locked.claimable) ? 'No rewards are currently released for withdrawal.' : undefined}
              />}
          />
        </div>
      )}
      </Card>}
    </>
  );
}

function ClaimButton({ bucket, amount, label, title, disabled, reason, scope = 'wallet', expectedLegacySellerRecipient }: { bucket: RewardBucket; amount: string; label?: string; title?: string; disabled?: boolean; reason?: string; scope?: 'buyer' | 'wallet'; expectedLegacySellerRecipient?: string }) {
  const { stale } = useContext(RewardRefreshContext);
  const body: ClaimRequest = { buckets: [bucket], scope, ...(expectedLegacySellerRecipient ? { expectedLegacySellerRecipient } : {}) };
  const empty = isZero(amount);
  return (
    <ActionButton
      label={label ?? 'Claim to wallet'}
      size="sm"
      title={title ?? (bucket === 'staker' ? 'Claim staking rewards' : 'Claim current seller rewards')}
      path="/api/rewards/claim"
      body={body}
      disabled={stale || disabled || empty}
      disabledReason={stale ? 'Wait for rewards to refresh before another action.' : reason ?? (empty ? 'Nothing to claim.' : undefined)}
    />
  );
}

/** Slider shared by every restake confirm; defaults to the maximum lock once the pool config is known. */
function useLock(maxEpochs: number | null) {
  const info = useEpochInfo();
  const positions = usePageData('positions:current', api.positions);
  const [epochs, setEpochs] = useState(maxEpochs ?? 1);
  useEffect(() => {
    if (maxEpochs !== null) setEpochs(maxEpochs);
  }, [maxEpochs]);
  return { epochs, setEpochs, positions, slider: <LockSlider value={epochs} min={positions.data?.config.minStakeEpochs ?? 1} max={maxEpochs ?? 1} startEpoch={info && positions.data ? info.current + positions.data.config.stakeActivationDelay : null} onChange={setEpochs} disabled={maxEpochs === null} /> };
}


function RestakeDestinations({ data, pools }: { data: RewardsView; pools: PoolView[] }) {
  const amounts = new Map<number, bigint>();
  for (const position of data.staker.positions) {
    const amount = toBigInt(position.amount) ?? 0n;
    if (amount > 0n) amounts.set(position.agentId, (amounts.get(position.agentId) ?? 0n) + amount);
  }
  if (amounts.size === 0) return <>Destination unavailable</>;
  return <div>{[...amounts].map(([agentId, amount]) => {
    const pool = pools.find(pool => pool.agentId === agentId);
    return <div key={agentId}>{pool ? poolName(pool) : `Seller pool #${agentId}`} · {formatAnts(amount.toString(), 4)} ANTS</div>;
  })}</div>;
}

/** Per-bucket restake using the existing endpoints. */
function RestakeButton({ kind, data, maxEpochs }: { kind: 'staker' | 'seller' | 'buyer'; data: RewardsView; maxEpochs: number | null }) {
  const { stale } = useContext(RewardRefreshContext);
  const { epochs, slider, positions } = useLock(maxEpochs);
  const pools = usePageData('pools', api.pools, 5 * 60_000, poolDataOptions);
  const [stakeAgent, setStakeAgent] = useState(() => (data.sellerUsage.agentId ? String(data.sellerUsage.agentId) : ''));
  const poolList: PoolView[] = pools.data?.pools ?? [];
  useEffect(() => {
    if (!stakeAgent && poolList[0]) setStakeAgent(String(poolList[0].agentId));
  }, [stakeAgent, poolList]);

  const amount = kind === 'staker' ? data.staker.total : kind === 'seller' ? data.sellerUsage.total : data.buyerUsage.total;
  const claimable = kind === 'staker' ? true : kind === 'seller' ? data.sellerUsage.claimable : data.buyerUsage.claimable;
  const path = kind === 'staker' ? '/api/rewards/restake' : '/api/rewards/stake-usage';
  const body: RestakeRequest | StakeUsageRequest =
    kind === 'staker' ? { epochs } : { side: kind, epochs, ...(kind === 'buyer' && stakeAgent ? { stakeAgentId: Number(stakeAgent) } : {}) };
  const sellerPool = poolList.find(pool => pool.agentId === data.sellerUsage.agentId);
  const target = kind === 'staker'
    ? <RestakeDestinations data={data} pools={poolList} />
    : sellerPool ? poolName(sellerPool) : data.sellerUsage.agentId ? `Seller pool #${data.sellerUsage.agentId}` : 'Destination unavailable';

  if (maxEpochs === null && claimable && !isZero(amount)) {
    if (positions.error && !positions.loading) {
      return <span className="btn-wrap" title={`Staking configuration could not be loaded: ${positions.error}`}>
        <Button variant="outline" size="sm" onClick={positions.refresh}>Retry loading</Button>
      </span>;
    }
    return <Button variant="outline" size="sm" disabled aria-busy="true" aria-label="Loading staking configuration">Loading…</Button>;
  }

  return (
    <ActionButton
      label="Stake rewards"
      size="sm"
      title={kind === 'staker' ? 'Stake position rewards' : `Stake current ${kind} rewards`}
      path={path}
      body={body}
      disabled={stale || isZero(amount) || !claimable || maxEpochs === null}
      disabledReason={stale ? 'Wait for rewards to refresh before another action.' : !claimable ? `${kind} usage rewards are not claimable from this wallet.` : 'No rewards are available to stake.'}
      validate={() => (maxEpochs === null ? 'Pool configuration is still loading.' : kind === 'buyer' && !stakeAgent ? 'Choose a pool to stake into.' : null)}
      summary={kind === 'buyer' ? [
        ['Amount', <span className="mono">{formatAnts(amount, 4)} ANTS</span>],
      ] : [
        ['Amount', <span className="mono">{formatAnts(amount, 4)} ANTS</span>],
        ['Into', target],
        ['Lock', <span className="mono">{epochs} epochs</span>],
      ]}
    >
      <div className="stack mt">
        {slider}
        {kind === 'buyer' ? (
          <Field label="Pool" width="lg" hint={pools.loading && !pools.data ? 'loading pools…' : undefined}>
            <Select value={stakeAgent} onChange={(e) => setStakeAgent(e.target.value)}>
              {poolList.map((p) => (
                <option key={p.agentId} value={p.agentId}>
                  {p.profile?.name?.trim() || `Agent ID ${p.agentId}`}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
    </ActionButton>
  );
}
