import { poolAprRange, poolAprEstimates, poolHeadlineApr, formatYieldPercent as percent, EXTREME_YIELD_NOTE, YIELD_DISPLAY_LIMIT } from '../pool-yield';
import { usePageData } from '../data';
import { poolDetailOptions } from '../pool-data';
import { api } from '../api';
import { Button, Card } from './ui';
import { Modal } from '@antseed/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { PoolActivity, SellerModels } from './PoolActivity';
import type { EpochVolume, PoolConfigView, PoolEpochPoint, PoolView, PoolYield, PoolsView, RewardsView } from '../../../src/api-types';
import { cmpBig, formatAnts, formatBps, formatInt, formatUsdcCompact, formatUtc, toBigInt } from '../format';
import { AddressLink } from './AddressLink';
import { EpochBarChart } from './Charts';
import { Input } from './Field';
import { Facts } from './Panel';
import { Pill } from './Pill';
import { Sparkline } from './Sparkline';
import { href } from '../router';
import { StakeForm } from './StakeForm';
import { Table, type Column } from './Table';

/** Seller name when indexed; otherwise an explicit pool identifier, never a wallet address as its name. */
export function poolName(pool: PoolView): string {
  return pool.profile?.name?.trim() || `Seller pool #${pool.agentId}`;
}

/** Select-option label: name plus agent id. */
export function poolLabel(pool: PoolView): string {
  return pool.profile?.name?.trim() ? `${poolName(pool)} · agent ${pool.agentId}` : poolName(pool);
}

export const POOL_ROW_CAP = 20;

/** Stakeable pools first; within a group by reward per 1k power (desc) when settled, then power, then this-epoch volume. */
export function sortPools(pools: PoolView[]): PoolView[] {
  return [...pools].sort((a, b) => {
    if (a.stakeable !== b.stakeable) return a.stakeable ? -1 : 1;
    const ra = a.lastEpochRewardPer1kPower;
    const rb = b.lastEpochRewardPer1kPower;
    if (ra !== null && rb !== null) {
      const c = cmpBig(rb, ra);
      if (c !== 0) return c;
    } else if (ra !== null) return -1;
    else if (rb !== null) return 1;
    const byPower = cmpBig(b.weight, a.weight);
    if (byPower !== 0) return byPower;
    return cmpBig(b.volumes[0]?.usdc ?? '0', a.volumes[0]?.usdc ?? '0');
  });
}

export type PoolSortMetric = 'apr' | 'volume' | 'stake';
type SortDirection = 'ascending' | 'descending';

function epochVolume(pool: PoolView, epoch: number): bigint | null {
  if (pool.volumeStatus !== 'available') return null;
  const row = pool.volumes.find((volume) => volume.epoch === epoch);
  return row ? toBigInt(row.usdc) : null;
}

/** Settled volume in the last completed epoch, or null when the explorer has no usable figure. */
function lastEpochVolume(pool: PoolView, currentEpoch: number): bigint | null {
  return epochVolume(pool, currentEpoch - 1);
}

/** Last completed epoch's volume against the one before, in percent; null without a prior epoch to compare. */
export function volumeChange(pool: PoolView, currentEpoch: number): number | null {
  const last = lastEpochVolume(pool, currentEpoch);
  const prior = epochVolume(pool, currentEpoch - 2);
  if (last === null || prior === null || prior === 0n) return null;
  return Number((last - prior) * 10_000n / prior) / 100;
}

function VolumeChange({ change }: { change: number | null }) {
  if (change === null) return null;
  const sign = change > 0 ? '▲' : change < 0 ? '▼' : '';
  const size = Math.abs(change);
  return <span className={change > 0 ? 'accent' : 'dim'}>{sign} {size > 999 ? '>999' : size.toLocaleString(undefined, { maximumFractionDigits: 0 })}% w/w</span>;
}

function bigOrZero(value: string | null | undefined): bigint {
  return toBigInt(value ?? null) ?? 0n;
}

function displayName(pool: PoolView): string {
  return pool.profile?.name?.trim() || 'Unnamed seller';
}

/** Sort the displayed metric, keeping unavailable values last in either direction. */
export function sortPoolsByMetric(pools: PoolView[], metric: PoolSortMetric, direction: SortDirection, currentEpoch: number): PoolView[] {
  const value = (pool: PoolView): number | bigint | null => {
    if (metric === 'apr') return poolHeadlineApr(pool);
    if (metric === 'stake') return toBigInt(pool.activeStake);
    return lastEpochVolume(pool, currentEpoch);
  };
  return [...pools].sort((a, b) => {
    const av = value(a), bv = value(b);
    if (av === null) return bv === null ? 0 : 1;
    if (bv === null) return -1;
    const order = av < bv ? -1 : av > bv ? 1 : 0;
    return direction === 'ascending' ? order : -order;
  });
}

function matchesFilter(pool: PoolView, needle: string): boolean {
  if (!needle) return true;
  const q = needle.toLowerCase();
  return String(pool.agentId) === needle || (pool.profile?.name ?? '').toLowerCase().includes(q) || (pool.seller ?? '').toLowerCase().includes(q);
}

/** Completed-epoch volumes, oldest first, for the row sparkline. */
export function volumeTrend(pool: PoolView, currentEpoch: number): Array<bigint | null> {
  return volumeTrendRows(pool, currentEpoch).map((row) => toBigInt(row.usdc));
}

function volumeTrendRows(pool: PoolView, currentEpoch: number): EpochVolume[] {
  if (pool.volumeStatus !== 'available') return [];
  return [...pool.volumes].filter((row) => row.epoch < currentEpoch).sort((a, b) => a.epoch - b.epoch);
}

/** Stake you hold in a pool counting both active and pending positions. */
export function yourTotalStake(pool: PoolView): bigint {
  return bigOrZero(pool.yourStake) + bigOrZero(pool.yourPendingStake);
}

/** An amount with a sub line; stake still waiting for its activation epoch takes the sub line in amber. */
function StakeCell({ amount, pending, sub, className }: { amount: string; pending: bigint; sub: string; className?: string }) {
  return (
    <span className={className ? `cell-stack ${className}` : 'cell-stack'}>
      {formatAnts(amount)}
      <span className="cell-sub">{pending > 0n ? <span className="pending-amount">+{formatAnts(pending)} pending</span> : sub}</span>
    </span>
  );
}

function YourStakeCell({ pool }: { pool: PoolView }) {
  const active = bigOrZero(pool.yourStake);
  const pending = bigOrZero(pool.yourPendingStake);
  if (active === 0n && pending === 0n) return <span className="dim">—</span>;
  if (active === 0n) return <span className="cell-stack pending-amount">{formatAnts(pending)}<span className="cell-sub">pending activation</span></span>;
  return <StakeCell amount={pool.yourStake} pending={pending} sub={`${formatBps(pool.yourPoolShareBps)} of pool`} className="accent" />;
}

interface TableProps {
  pools: PoolView[];
  currentEpoch: number;
  loading: boolean;
  walletSyncing?: boolean;
  onOpen: (pool: PoolView) => void;
  onStake: (pool: PoolView) => void;
}

export function PoolsTable({ pools, currentEpoch, loading, walletSyncing = false, onOpen, onStake }: TableProps) {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [sortBy, setSortBy] = useState<PoolSortMetric>('apr');
  const [sortDirection, setSortDirection] = useState<SortDirection>('descending');
  const [onlyMine, setOnlyMine] = useState(false);
  const sortHeader = (metric: PoolSortMetric, label: string) => (
    <button type="button" className="table-sort" aria-label={`Sort by ${label}, ${sortBy === metric && sortDirection === 'descending' ? 'ascending' : 'descending'}`} onClick={() => {
      setSortDirection(sortBy === metric && sortDirection === 'descending' ? 'ascending' : 'descending');
      setSortBy(metric);
      setShowAll(false);
    }}>{label} <span aria-hidden="true">{sortBy === metric ? sortDirection === 'descending' ? '↓' : '↑' : '↕'}</span></button>
  );
  const needle = filter.trim();
  const stakeablePools = useMemo(() => pools.filter(pool => pool.stakeable), [pools]);
  const mineCount = useMemo(() => stakeablePools.filter((pool) => yourTotalStake(pool) > 0n).length, [stakeablePools]);
  const filtered = useMemo(() => sortPoolsByMetric(
    stakeablePools.filter(pool => matchesFilter(pool, needle) && (!onlyMine || yourTotalStake(pool) > 0n)),
    sortBy, sortDirection, currentEpoch,
  ), [stakeablePools, needle, sortBy, sortDirection, currentEpoch, onlyMine]);
  const capped = !showAll && filtered.length > POOL_ROW_CAP;
  const visible = capped ? filtered.slice(0, POOL_ROW_CAP) : filtered;
  const columns: Array<Column<PoolView>> = [
    {
      key: 'seller',
      label: 'Seller',
      render: (p) => (
          <div className="seller-cell">
            <button type="button" className="pool-details-trigger" aria-label={`View ${displayName(p)} overview`} aria-haspopup="dialog" onClick={event => { event.stopPropagation(); onOpen(p); }}>{displayName(p)}</button>
            <span className="seller-cell-meta">
              {p.stakers != null ? <span>{formatInt(p.stakers)} {p.stakers === 1 ? 'staker' : 'stakers'}</span> : p.openPositions !== undefined ? <span>{formatInt(p.openPositions)} {p.openPositions === 1 ? 'position' : 'positions'}</span> : null}
              {p.profile?.modelsServed != null ? <span>{formatInt(p.profile.modelsServed)} models</span> : null}
            </span>
          </div>
      ),
    },
    {
      key: 'trend',
      label: 'Volume trend',
      title: 'Settled USDC volume over the last completed epochs.',
      render: (p) => (
        <Sparkline
          values={volumeTrend(p, currentEpoch)}
          labels={volumeTrendRows(p, currentEpoch).map((row) => `Epoch ${row.epoch}`)}
          format={(value) => `${formatUsdcCompact(BigInt(Math.round(value)))} USDC`}
          label={`${displayName(p)} settled volume over recent epochs`}
          tone={(lastEpochVolume(p, currentEpoch) ?? 0n) > 0n ? 'accent' : 'muted'}
        />
      ),
    },
    {
      key: 'apr', label: sortHeader('apr', 'APR · max lock'),
      sortDirection: sortBy === 'apr' ? sortDirection : 'none',
      title: 'Estimated APR for a new 10,000 ANTS stake at max lock, from the last complete epoch, with the epoch in progress below.',
      align: 'right', mono: true,
      render: (pool: PoolView) => <PoolApr pool={pool} />,
    },
    {
      key: 'stake', label: sortHeader('stake', 'TVL'), sortDirection: sortBy === 'stake' ? sortDirection : 'none', title: 'Total active stake in this pool (ANTS).', align: 'right', mono: true,
      render: p => <StakeCell amount={p.activeStake} pending={bigOrZero(p.pendingStake)} sub={`${formatBps(p.powerShareBps)} power`} />,
    },
    {
      key: 'volume', label: sortHeader('volume', 'Last epoch'), sortDirection: sortBy === 'volume' ? sortDirection : 'none', title: 'Settled USDC volume in the last completed epoch.', align: 'right', mono: true,
      render: p => {
        const volume = lastEpochVolume(p, currentEpoch);
        if (volume === null) return '—';
        const change = volumeChange(p, currentEpoch);
        return change === null ? formatUsdcCompact(volume) : <span className="cell-stack">{formatUsdcCompact(volume)}<span className="cell-sub"><VolumeChange change={change} /></span></span>;
      },
    },
    { key: 'yours', label: 'Your stake', align: 'right', mono: true, render: p => walletSyncing ? <span className="dim">Updating…</span> : <YourStakeCell pool={p} /> },
    {
      key: 'actions',
      label: '',
      align: 'right',
      className: 'col-actions',
      render: (p) =>
        p.stakeable ? (
          <span onClick={(e) => e.stopPropagation()}>
            <Button variant="outline" size="sm" onClick={() => onStake(p)}>
              Stake
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <>
      <div className="pools-toolbar">
        {stakeablePools.length > 5 ? (
          <Input label="" mono={false} width="md" placeholder="Search seller or agent id" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter pools" />
        ) : null}
        {mineCount > 0 && !walletSyncing ? (
          <button type="button" className="lock-preset" aria-pressed={onlyMine} onClick={() => setOnlyMine((v) => !v)}>
            my pools · {mineCount}
          </button>
        ) : null}
        {!loading ? <span className="muted small">
          {needle || onlyMine ? `${formatInt(filtered.length)} of ` : ''}{formatInt(stakeablePools.length)} {stakeablePools.length === 1 ? 'seller' : 'sellers'}
        </span> : null}
      </div>
      {stakeablePools.some(pool => pool.displaySource?.error) ? <p className="hint">Some Antscan statistics are unavailable or may lag. Missing historical yield is shown as —; open a provider for details.</p> : null}
      <Table
        columns={columns}
        rows={visible}
        rowKey={(p) => p.agentId}
        loading={loading}
        onRowClick={onOpen}
        empty={needle ? `No seller matches "${needle}" in this view.` : onlyMine ? 'You have no stake in any seller yet.' : 'No sellers are ready for staking yet.'}
      />
      {filtered.length > POOL_ROW_CAP ? (
        <div className="pools-more">
          <span className="muted small">
            Showing {formatInt(visible.length)} of {formatInt(filtered.length)}
          </span>
          <button type="button" className="link-button" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : 'Show all'}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** Everything the side column needs to stake straight from the sheet. */
export interface StakePanelProps {
  config: PoolConfigView | null;
  balance?: string;
  rewards?: RewardsView | null;
  rewardsError?: string | null;
  walletReady: boolean;
}

export function PoolDrawer({ pool: initialPool, view, onClose, stake }: { pool: PoolView; view: PoolsView; onClose: () => void; stake?: StakePanelProps }) {
  const detail = usePageData(`pool:${initialPool.agentId}`, () => api.pool(initialPool.agentId), 60_000, poolDetailOptions);
  const pool = detail.data ?? initialPool;
  const walletSyncing = detail.data ? detail.reconciling : !!view.walletSyncing;
  const historyRefreshFailed = !!detail.error || (!!detail.data && detail.data.volumeStatus !== 'available');
  const history = historyRefreshFailed && initialPool.volumeStatus === 'available' ? initialPool : pool;
  const historyEpoch = history === initialPool ? view.currentEpoch : detail.data?.currentEpoch ?? view.currentEpoch;
  const profile = pool.profile;
  const explorerUrl = view.explorer && pool.seller ? `${view.explorer.replace(/\/$/, '')}/account/${pool.seller}` : null;
  const latest = history.volumes.find(volume => volume.epoch === historyEpoch - 1);
  const yourStake = bigOrZero(pool.yourStake);
  const yourPending = bigOrZero(pool.yourPendingStake);
  const poolPending = bigOrZero(pool.pendingStake);

  return (
    <Modal isOpen onClose={onClose} size="lg" overlayClassName="ants-stake-overlay ants-pool-overlay" className="pool-overview" title={poolName(pool)} eyebrow="SELLER" subtitle={<>
      Agent <span className="mono">{pool.agentId}</span> · {pool.seller ? <AddressLink value={pool.seller} copy /> : 'No seller bound'}
      {explorerUrl ? <> · <a href={explorerUrl} target="_blank" rel="noreferrer">View on Antscan ↗</a></> : null}
    </>}>
      <div className="vault">
        <div className="vault-main">
          <div className="pool-overview-status">
            <Pill tone={pool.stakeable ? 'accent' : 'muted'}>{pool.hasPool ? 'Staking pool' : 'No pool yet'}</Pill>
            {profile?.providers.length ? profile.providers.slice(0, 4).map((provider) => <Pill key={provider} tone="muted">{provider}</Pill>) : null}
            {pool.openPositions !== undefined ? <span>{formatInt(pool.openPositions)} open positions{pool.stakers != null ? ` · ${formatInt(pool.stakers)} stakers` : ''}</span> : null}
            {pool.displaySource?.source === 'indexer' ? <span className="dim">Antscan block {pool.displaySource.indexedBlock}</span> : null}
          </div>
          {pool.displaySource?.error ? <p className="hint">Antscan: {pool.displaySource.error}{pool.yield?.status === 'unavailable' ? ' Historical yield is unavailable.' : ''}</p> : null}
          <div className="pool-metrics">
            <div><span className="tile-label">Total value locked</span><strong>{formatAnts(pool.activeStake)} <small>ANTS</small></strong>{poolPending > 0n ? <span className="small pending-amount">+{formatAnts(poolPending)} ANTS pending activation</span> : null}</div>
            <div><span className="tile-label">Last epoch volume</span><strong>{latest && history.volumeStatus === 'available' ? formatUsdcCompact(latest.usdc) : '—'} <small>USDC</small></strong><span className="small"><VolumeChange change={volumeChange(history, historyEpoch)} /></span></div>
            <div><span className="tile-label">Power share</span><strong>{formatBps(pool.powerShareBps)}</strong><span className="small muted">of all pools' staking power</span></div>
            <div><span className="tile-label">Last epoch rewards</span><strong>{pool.lastEpochEmission != null ? formatAnts(pool.lastEpochEmission) : '—'} <small>ANTS</small></strong><span className="small muted">{pool.lastEpochEmission != null ? (pool.lastEpochEmissionSettled ? 'settled to stakers' : 'estimated, not settled') : 'no usage yet'}</span></div>
          </div>
          <section className="pool-apy-section" aria-label="Estimated APR by lock">
            <div className="pool-section-heading"><h3>Estimated APR by lock</h3><span className="small muted">New 10,000 ANTS stake · longer locks earn more power</span></div>
            <PoolAprEstimates pool={pool} />
            <StakerRewardsHelp maxLockEpochs={(pool.yield ?? pool.liveYield)?.maxLockEpochs ?? null} />
          </section>
          <section className="pool-section">
            <div className="pool-section-heading"><h3>Settled volume · completed epochs</h3><span className="small muted">Includes legacy seller activity.</span></div>
            {historyRefreshFailed && history === initialPool && history.volumeStatus === 'available' && <p className="hint">Seller history could not refresh. Showing previously loaded history.</p>}
            {history.volumeStatus !== 'available' && <p className="hint">Settlement volume {history.volumeStatus === 'stale' ? 'is stale' : 'is unavailable'}. Usage points are not revenue.</p>}
            <PoolActivity volumes={history.volumes} networkVolumes={view.networkVolumes} currentEpoch={historyEpoch} />
            {history.statsUpdatedAt && <p className="small muted">History fetched {formatUtc(Math.floor(history.statsUpdatedAt / 1000))}</p>}
          </section>
          <section className="pool-section">
            <div className="pool-section-heading"><h3>Stake, power and staker rewards</h3><span className="small muted">{detail.loading && !detail.data ? 'loading history…' : pool.history?.length ? `${pool.history.length} indexed epochs` : 'no indexed history'}</span></div>
            <PoolHistoryCharts history={pool.history ?? []} currentEpoch={historyEpoch} />
          </section>
          <section className="pool-section">
            <div className="pool-section-heading"><h3>Seller profile · lifetime activity</h3><span className="small muted">Antscan indexed totals</span></div>
            {profile?.stale && <p className="hint">Seller activity is stale; the indexer could not refresh.</p>}
            {profile ? <div className="pool-lifetime">
              <div><span className="tile-label">Settled volume</span><strong>{profile.lifetimeVolumeUsdc != null ? `${formatUsdcCompact(profile.lifetimeVolumeUsdc)} USDC` : '—'}</strong></div>
              <div><span className="tile-label">Requests</span><strong>{profile.requestCount != null ? formatInt(profile.requestCount) : '—'}</strong></div>
              <div><span className="tile-label">Unique buyers</span><strong>{profile.uniqueBuyers != null ? formatInt(profile.uniqueBuyers) : '—'}</strong></div>
              <div><span className="tile-label">Models served</span><strong>{profile.modelsServed != null ? formatInt(profile.modelsServed) : '—'}</strong></div>
            </div> : <p className="hint">The explorer has no record for this seller.</p>}
            <Facts items={[
              ['Providers', profile?.providers.length ? profile.providers.join(', ') : '—'],
              ['Last epoch emission', pool.lastEpochEmission != null ? `${formatAnts(pool.lastEpochEmission, 4)} ANTS` : '—'],
              ['Ghost rate', profile?.ghostRate != null && Number.isFinite(profile.ghostRate) && profile.ghostRate >= 0 && profile.ghostRate <= 100 ? `${profile.ghostRate.toFixed(1)}%` : 'Unavailable'],
              ['Last settled', profile?.lastSettledAt != null ? formatUtc(profile.lastSettledAt) : '—'],
            ]} />
            {profile?.fetchedAt && <p className="small muted">Profile fetched {formatUtc(Math.floor(profile.fetchedAt / 1000))}</p>}
          </section>
          <SellerModels address={pool.seller} />
        </div>
        <aside className="vault-side" aria-label="Your position and staking">
          <Card>
            <h3>Your position</h3>
            {walletSyncing ? <p className="hint" role="status">Updating… Waiting for Antscan to include your latest transaction.</p> : <div className="vault-your">
              <div><span className="tile-label">Staked</span><strong>{yourStake > 0n ? formatAnts(pool.yourStake) : '—'}</strong></div>
              <div><span className="tile-label">Pending activation</span><strong className={yourPending > 0n ? 'pending-amount' : undefined}>{yourPending > 0n ? formatAnts(pool.yourPendingStake) : '—'}</strong></div>
              <div><span className="tile-label">Power</span><strong>{yourStake > 0n ? formatAnts(pool.yourPower) : '—'}</strong></div>
              <div><span className="tile-label">Pool share</span><strong>{yourStake > 0n ? formatBps(pool.yourPoolShareBps) : '—'}</strong></div>
              <div><span className="tile-label">Positions</span><strong>{pool.yourPositionIds?.length || '—'}</strong></div>
            </div>}
            {!walletSyncing && yourPending > 0n ? <p className="hint">Pending stake starts earning at its activation epoch; it is listed under <a href={href('positions')}>My positions</a> with its start date.</p> : null}
          </Card>
          <Card>
            <h3>Stake into {poolName(pool)}</h3>
            {stake ? (
              <StakeForm
                key={`${pool.agentId}:${stake.walletReady}`}
                config={stake.config}
                pools={[pool]}
                balance={stake.balance}
                rewards={stake.rewards}
                rewardsError={stake.rewardsError}
                defaultAgentId={pool.agentId}
                lockedPool
              />
            ) : <p className="hint">Open this seller from the Stake page to stake into it.</p>}
          </Card>
        </aside>
      </div>
    </Modal>
  );
}

const ANTS_UNIT = 10n ** 18n;
/** Axis ticks: compact above 1k ANTS, two decimals below 100 so tiny pools do not read as all zeros. */
export const shortAnts = (value: bigint): string => {
  const whole = value / ANTS_UNIT;
  if (whole >= 1_000_000n) return `${(Number(whole) / 1e6).toFixed(1)}M`;
  if (whole >= 10_000n) return `${(Number(whole) / 1e3).toFixed(0)}k`;
  if (whole >= 1_000n) return `${(Number(whole) / 1e3).toFixed(1)}k`;
  if (whole >= 100n) return whole.toString();
  return formatAnts(value, 2);
};

/** Two charts from indexed pool epochs: stake with power on the second axis, and staker emission per epoch. */
export function PoolHistoryCharts({ history, currentEpoch }: { history: PoolEpochPoint[]; currentEpoch: number }) {
  const rows = history.filter((row) => row.epoch <= currentEpoch);
  const epochs = rows.map((row) => row.epoch);
  const stake = rows.map((row) => toBigInt(row.activeStake));
  const power = rows.map((row) => toBigInt(row.weight));
  const emission = rows.map((row) => toBigInt(row.emission));
  const provisional = rows.map((row) => !row.settled);
  return (
    <div className="chart-grid-2">
      <EpochBarChart
        epochs={epochs}
        title="Active stake per epoch as bars (ANTS, left axis) with pool power as a line (right axis)."
        bars={{ key: 'stake', name: 'Active stake · ANTS', values: stake, format: (value) => `${formatAnts(value)} ANTS`, tick: shortAnts }}
        line={{ key: 'power', name: 'Pool power', values: power, format: (value) => formatAnts(value), tick: shortAnts }}
      />
      <EpochBarChart
        epochs={epochs}
        title="Staker rewards per epoch (ANTS). Hollow bars are estimates for epochs not yet settled."
        bars={{ key: 'emission', name: 'Staker rewards · ANTS', values: emission, format: (value) => `${formatAnts(value, 2)} ANTS`, tick: shortAnts, provisional }}
      />
    </div>
  );
}

const formatWeekly = (reward: bigint | null): string => reward === null ? '—' : `${formatAnts(reward, reward < 10n ** 19n ? 2 : 0)} ANTS`;

export function PoolAprEstimates({ pool }: { pool: PoolView }) {
  const live = poolAprEstimates(pool.liveYield);
  return <dl className="pool-apy-estimates">
    {poolAprEstimates(pool.yield).map((period, index) => {
      const now = live[index];
      return <div key={period.label} title={period.status === 'unsupported'
        ? `${period.label} is not supported by this pool's whole-epoch lock limits.`
        : period.apr === null ? 'APR is unavailable because reward or epoch data is missing.'
          : `New 10,000 ANTS stake. ${period.epochs} epoch(s), ${period.actualDays} days of power. Last complete epoch (${pool.yield!.epoch}) repeated for a year, not compounded; not the return over this lock.${pool.yield?.status === 'estimated' ? ' Rewards are not yet settled.' : ''}`}>
        <dt>{period.label}</dt>
        <dd>{period.status === 'unsupported' ? <span className="pool-apy-unavailable">Unsupported</span> : <>
          {percent(period.apr)}{period.apr !== null && period.apr <= YIELD_DISPLAY_LIMIT && pool.yield?.status === 'estimated' ? <span className="dim small"> est.</span> : null}
          {period.epochReward !== null ? <span className="small muted pool-apy-weekly">{formatWeekly(period.epochReward)} / epoch</span> : null}
          {now?.apr != null ? <span className="small muted pool-apy-weekly">this epoch {percent(now.apr)}</span> : null}
        </>}</dd>
      </div>;
    })}
  </dl>;
}

/** How a staker's reward is decided, in the terms a staker chooses by: seller volume, lock length and timing. */
export function StakerRewardsHelp({ maxLockEpochs }: { maxLockEpochs: number | null }) {
  return <p className="small muted pool-rewards-help">
    Each pool's staker rewards are its share of recognized volume × power; inside the pool they split by power, so the pool's size cancels out.
    Per unit of power you earn in proportion to this seller's volume, and lock length multiplies your power{maxLockEpochs ? ` (max lock = ${formatInt(maxLockEpochs)}×)` : ''}.
    Rates are high while total network power is small and compress as more stake arrives, so early stake with a seller whose volume is growing earns the most.
    Estimates repeat one epoch for a year without compounding and aren't guaranteed.
  </p>;
}

/** The yield the headline APR comes from: the last complete epoch when it prices, else the epoch in progress. */
function headlineYield(pool: PoolView): PoolYield | undefined {
  if (poolAprRange(pool.yield).maxLock.apr !== null) return pool.yield;
  if (poolAprRange(pool.liveYield).maxLock.apr !== null) return pool.liveYield;
  return [pool.yield, pool.liveYield].find((info) => info && info.status !== 'unavailable');
}

function yieldDescription(pool: PoolView): string {
  const info = headlineYield(pool);
  if (!info) return 'Yield is unavailable.';
  const range = poolAprRange(info);
  const duration = info.endsAt - info.startsAt;
  const source = info === pool.yield ? `last complete epoch ${info.epoch}` : `epoch ${info.epoch} in progress`;
  return `New 10,000 ANTS stake at max lock (${range.maxLock.epochs ?? '—'} epochs of power), including the stake's own added points. 1-week lock: ${percent(range.oneWeek.apr)}. Source: ${source}, ${formatUtc(info.startsAt)} – ${formatUtc(info.startsAt + duration)}. The epoch repeated for a year, not compounded. Rates compress as stake joins the network. Returns aren’t guaranteed. — means unavailable.${info.status === 'estimated' ? ' Rewards not yet settled.' : ''}`;
}

export function PoolApr({ pool }: { pool: PoolView }): ReactNode {
  const last = poolAprRange(pool.yield).maxLock;
  const live = poolAprRange(pool.liveYield).maxLock;
  const headline = last.apr ?? live.apr;
  const extreme = (headline ?? 0) > YIELD_DISPLAY_LIMIT;
  const trend = last.apr !== null && live.apr !== null ? (live.apr > last.apr ? '▲ ' : live.apr < last.apr ? '▼ ' : '') : '';
  return <span className="cell-stack" title={`${yieldDescription(pool)}${extreme ? ` ${EXTREME_YIELD_NOTE}` : ''}`}>
    <span className={`yield-percent${headline !== null ? ' yield-percent--hot' : ''}`}>
      {percent(headline)}
      {headline !== null && !extreme && (last.apr === null || pool.yield?.status === 'estimated') ? <span className="dim small"> est.</span> : null}
    </span>
    {last.apr !== null && live.apr !== null ? <span className="cell-sub">{trend}{percent(live.apr)} this epoch</span>
      : last.apr === null && live.apr !== null ? <span className="cell-sub">this epoch so far</span> : null}
  </span>;
}
