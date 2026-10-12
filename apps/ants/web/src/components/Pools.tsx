import { poolApyRange, poolApyEstimates, formatYieldPercent as percent, EXTREME_YIELD_LABEL, EXTREME_YIELD_NOTE, YIELD_DISPLAY_LIMIT } from '../pool-yield';
import { usePageData } from '../data';
import { poolDetailOptions } from '../pool-data';
import { api } from '../api';
import { Button, Card } from './ui';
import { Modal } from '@antseed/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { PoolActivity, SellerModels } from './PoolActivity';
import type { EpochVolume, PoolConfigView, PoolEpochPoint, PoolView, PoolsView, RewardsView } from '../../../src/api-types';
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

export type PoolSortMetric = 'apy' | 'volume' | 'stake';
type SortDirection = 'ascending' | 'descending';

/** Settled volume in the last completed epoch, or null when the explorer has no usable figure. */
function lastEpochVolume(pool: PoolView, currentEpoch: number): bigint | null {
  if (pool.volumeStatus !== 'available') return null;
  const row = pool.volumes.find((volume) => volume.epoch === currentEpoch - 1);
  return row ? toBigInt(row.usdc) : null;
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
    if (metric === 'apy') return poolApyRange(pool.yield).oneWeek.apy;
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
  const [sortBy, setSortBy] = useState<PoolSortMetric>('apy');
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
      key: 'apy', label: sortHeader('apy', 'APY'),
      sortDirection: sortBy === 'apy' ? sortDirection : 'none',
      align: 'right', mono: true,
      render: (pool: PoolView) => <PoolApy pool={pool} />,
    },
    {
      key: 'stake', label: sortHeader('stake', 'TVL'), sortDirection: sortBy === 'stake' ? sortDirection : 'none', title: 'Total active stake in this pool (ANTS).', align: 'right', mono: true,
      render: p => <StakeCell amount={p.activeStake} pending={bigOrZero(p.pendingStake)} sub={`${formatBps(p.powerShareBps)} power`} />,
    },
    {
      key: 'volume', label: sortHeader('volume', 'Last epoch'), sortDirection: sortBy === 'volume' ? sortDirection : 'none', title: 'Settled USDC volume in the last completed epoch.', align: 'right', mono: true,
      render: p => { const volume = lastEpochVolume(p, currentEpoch); return volume === null ? '—' : formatUsdcCompact(volume); },
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
            <div><span className="tile-label">Last epoch volume</span><strong>{latest && history.volumeStatus === 'available' ? formatUsdcCompact(latest.usdc) : '—'} <small>USDC</small></strong></div>
            <div><span className="tile-label">Power share</span><strong>{formatBps(pool.powerShareBps)}</strong><span className="small muted">of all pools' staking power</span></div>
            <div><span className="tile-label">Last epoch rewards</span><strong>{pool.lastEpochEmission != null ? formatAnts(pool.lastEpochEmission) : '—'} <small>ANTS</small></strong><span className="small muted">{pool.lastEpochEmission != null ? (pool.lastEpochEmissionSettled ? 'settled to stakers' : 'estimated, not settled') : 'no usage yet'}</span></div>
          </div>
          <section className="pool-apy-section" aria-label="Estimated APY by lock">
            <div className="pool-section-heading"><h3>Estimated APY by lock</h3><span className="small muted">10,000 ANTS reference stake · longer locks earn more power</span></div>
            <PoolApyEstimates pool={pool} />
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

export function PoolApyEstimates({ pool }: { pool: PoolView }) {
  return <dl className="pool-apy-estimates">
    {poolApyEstimates(pool.yield).map(period => <div key={period.label} title={period.status === 'unsupported'
      ? `${period.label} is not supported by this pool's whole-epoch lock limits.`
      : period.apy === null ? 'APY is unavailable because reward or epoch data is missing.'
        : `10,000 ANTS reference stake. ${period.epochs} epoch(s), ${period.actualDays} days. Annualized initial earning rate with hypothetical compounding; not the return over this lock. APY above 10,000% is shown as ${EXTREME_YIELD_LABEL}. Source epoch ${pool.yield!.epoch}.${pool.yield?.status === 'estimated' ? ' Rewards are not yet settled.' : ''}`}>
      <dt>{period.label}</dt><dd>{period.status === 'unsupported' ? <span className="pool-apy-unavailable">Unsupported</span> : <>{percent(period.apy)}{period.apy !== null && period.apy <= YIELD_DISPLAY_LIMIT && pool.yield?.status === 'estimated' ? <span className="dim small"> est.</span> : null}</>}</dd>
    </div>)}
  </dl>;
}

function yieldDescription(pool: PoolView): string {
  const info = pool.yield;
  if (!info || info.status === 'unavailable') return 'Last-epoch yield is unavailable.';
  const range = poolApyRange(info);
  const duration = info.endsAt - info.startsAt;
  const lockLabel = (epochs: number | null) => epochs === null ? 'unavailable' : `${epochs} epoch(s), ${epochs * duration / 86400} days`;
  return `10,000 ANTS reference stake, including added pool power. 1 week: ${lockLabel(range.oneWeek.epochs)}; 2 years: ${lockLabel(range.twoYears.epochs)}. Source epoch ${info.epoch}: ${formatUtc(info.startsAt)} – ${formatUtc(info.endsAt)}. Assumes rewards and initial rates repeat each epoch; compounding is not automatic. Excludes declining power and activation delays. Returns aren’t guaranteed. — means unavailable.${info.status === 'estimated' ? ' Rewards not yet settled.' : ''}`;
}

export function PoolApy({ pool }: { pool: PoolView }): ReactNode {
  const { oneWeek, twoYears } = poolApyRange(pool.yield);
  const available = oneWeek.apy !== null || twoYears.apy !== null;
  const extreme = (oneWeek.apy ?? 0) > YIELD_DISPLAY_LIMIT || (twoYears.apy ?? 0) > YIELD_DISPLAY_LIMIT;
  const low = percent(oneWeek.apy), high = percent(twoYears.apy);
  return <span className={`yield-percent${available ? ' yield-percent--hot' : ''}`} title={`${yieldDescription(pool)}${extreme ? ` ${EXTREME_YIELD_NOTE}` : ''}`}>
    {extreme ? EXTREME_YIELD_LABEL : available ? `${low} – ${high}` : '—'}
    {available && !extreme && pool.yield?.status === 'estimated' ? <span className="dim small"> est.</span> : null}
  </span>;
}
