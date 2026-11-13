import styles from './SellerPoolsTokenomicsCharts.module.css';

const M = 1_000_000;
const CURRENT_EPOCH = 9;
const YEARS = 20;
const WEEKS_PER_YEAR = 52;
const WEEKS = YEARS * WEEKS_PER_YEAR;
const HALVING = 104;
const INITIAL_EMISSION = 5 * M;
const ALREADY_EMITTED = CURRENT_EPOCH * INITIAL_EMISSION;
const ALREADY_EMITTED_SELLERS = ALREADY_EMITTED * 0.50;
const ALREADY_EMITTED_BUYERS = ALREADY_EMITTED * 0.20;
const ALREADY_EMITTED_RESERVE = ALREADY_EMITTED * 0.15;
const ALREADY_EMITTED_TEAM = ALREADY_EMITTED * 0.15;
const START_SUPPLY = 37.787779698923878 * M;
const START_TEAM = 6 * M;
const START_RESERVE = 8.211717050437676 * M;
const START_COMMUNITY_STAKE = 14.5 * M;
const FOUNDATION_STAKE_START_SHARE = 0.80;
const FOUNDATION_STAKE_FLOOR_SHARE = 0.05;
const EARLY_WITHDRAW_BURN_SHARE = 0.025;
const TEAM_SHARE = 15;
const RESERVE_SHARE = 15;
const VERIFICATION_SHARE = 10;
const STAKER_MAX_SHARE = 40;
const STAKER_MIN_SHARE = 2;
const BUYER_MIN_SHARE = 5;
const BUYER_MAX_SHARE = 10;
const SELLER_MIN_SHARE = 5;
const SELLER_MAX_SHARE = 10;
const STAKE_SHARE_TARGET = 500 * M;
const START_STAKED_CIRCULATING_SHARE = START_COMMUNITY_STAKE / START_SUPPLY;
const MAX_STAKED_CIRCULATING_SHARE = 0.55;
const STAKED_CIRCULATING_RAMP_YEARS = 8;
const RECOGNIZED_USDC_VOLUME_TARGET = 1 * M;
const START_RECOGNIZED_VOLUME = 15_000;
const RECOGNIZED_VOLUME_TARGET_WEEKS = WEEKS_PER_YEAR * 2;
const RECOGNIZED_VOLUME_ANNUAL_GROWTH = 0.16;
const EMISSION_BURN_CAP_SHARE = 30;

const COLORS = {
  team: '#7f8a83',
  reserve: '#7a6f9b',
  remainderReserve: '#b18b5a',
  burn: '#6f4b50',
  remainderBurn: '#a35f5f',
  exitBurn: '#b47a68',
  verification: '#4f93a3',
  buyers: '#9b6f96',
  sellers: '#5f7fa8',
  stakers: '#6f9a7e',
  gray: 'var(--as-text-3)',
};

const EMISSION_LEDGER = [
  {label: 'Contributors', shareLabel: '15%', shareValue: TEAM_SHARE, color: COLORS.team},
  {label: 'Antseed Foundation', shareLabel: '15%', shareValue: RESERVE_SHARE, color: COLORS.reserve},
  {label: 'Verification', shareLabel: '10%', shareValue: VERIFICATION_SHARE, color: COLORS.verification},
  {label: 'Seller-pool stakers', shareLabel: '2-40%', shareValue: STAKER_MAX_SHARE, color: COLORS.stakers},
  {label: 'Sellers / operators', shareLabel: '5-10%', shareValue: SELLER_MAX_SHARE, color: COLORS.sellers},
  {label: 'Buyers', shareLabel: '5-10%', shareValue: BUYER_MAX_SHARE, color: COLORS.buyers},
] as const;

const X_TICKS = [
  {week: 0, label: 'now'},
  {week: WEEKS_PER_YEAR, label: 'Y1'},
  {week: WEEKS_PER_YEAR * 2, label: 'Y2'},
  {week: WEEKS_PER_YEAR * 5, label: 'Y5'},
  {week: WEEKS_PER_YEAR * 10, label: 'Y10'},
  {week: WEEKS_PER_YEAR * 15, label: 'Y15'},
  {week: WEEKS - 1, label: 'Y20'},
] as const;

const PROJECTION_NOTE = '* Projection only; final parameters may change.';

type ModelRow = {
  week: number;
  epoch: number;
  emission: number;
  emitted: number;
  recognizedVolume: number;
  projectedCirculating: number;
  activeStakeForBudget: number;
  team: number;
  baseReserve: number;
  verification: number;
  buyers: number;
  sellers: number;
  stakerGross: number;
  stakers: number;
  stakerDesired: number;
  stakerMaxBudget: number;
  usageRemainder: number;
  stakerRemainder: number;
  emissionRemainder: number;
  burn: number;
  remainderBurn: number;
  remainderReserve: number;
  earlyWithdrawBurn: number;
  communityStake: number;
  reserveStake: number;
  totalStake: number;
  stakerSharePct: number;
  stakerDesiredSharePct: number;
  buyerSharePct: number;
  sellerSharePct: number;
  teamTotal: number;
  fixedReserveTotal: number;
  reserveTotal: number;
  circulating: number;
  stakerGrossTotal: number;
  stakersTotal: number;
  burnTotal: number;
  remainderBurnTotal: number;
  earlyWithdrawBurnTotal: number;
  remainderReserveTotal: number;
  verificationTotal: number;
  buyersTotal: number;
  sellersTotal: number;
};

type Model = {
  rows: ModelRow[];
  totals: {
    team: number;
    baseReserve: number;
    verification: number;
    buyers: number;
    sellers: number;
    stakerGross: number;
    stakers: number;
    burn: number;
    remainderBurn: number;
    earlyWithdrawBurn: number;
    remainderReserve: number;
  };
};

type ChartSeries = {
  label: string;
  color: string;
  values: number[];
  dashed?: boolean;
};

type DistributionSeries = {
  label: string;
  color: string;
  values: number[];
};

function emissionForEpoch(epoch: number): number {
  return INITIAL_EMISSION / Math.pow(2, Math.floor(epoch / HALVING));
}

function saturatingShare(metric: number, minShare: number, maxShare: number, target: number): number {
  if (metric <= 0) return 0;
  return minShare + (maxShare - minShare) * metric / (metric + target);
}

function recognizedVolumeForWeek(week: number): number {
  if (week <= RECOGNIZED_VOLUME_TARGET_WEEKS) {
    return START_RECOGNIZED_VOLUME * Math.pow(
      RECOGNIZED_USDC_VOLUME_TARGET / START_RECOGNIZED_VOLUME,
      week / RECOGNIZED_VOLUME_TARGET_WEEKS,
    );
  }

  return RECOGNIZED_USDC_VOLUME_TARGET * Math.pow(
    1 + RECOGNIZED_VOLUME_ANNUAL_GROWTH,
    (week - RECOGNIZED_VOLUME_TARGET_WEEKS) / WEEKS_PER_YEAR,
  );
}

function stakedCirculatingShareForWeek(week: number): number {
  const progress = Math.min(1, week / (WEEKS_PER_YEAR * STAKED_CIRCULATING_RAMP_YEARS));
  const ramp = 1 - Math.pow(1 - progress, 1.6);

  return START_STAKED_CIRCULATING_SHARE + (MAX_STAKED_CIRCULATING_SHARE - START_STAKED_CIRCULATING_SHARE) * ramp;
}

function projectedCirculatingFromTotals(totals: Model['totals']): number {
  return Math.max(
    0,
    START_SUPPLY + totals.stakers + totals.sellers + totals.buyers + totals.verification,
  );
}

function buildModel(): Model {
  const totals: Model['totals'] = {
    team: 0,
    baseReserve: 0,
    verification: 0,
    buyers: 0,
    sellers: 0,
    stakerGross: 0,
    stakers: 0,
    burn: 0,
    remainderBurn: 0,
    earlyWithdrawBurn: 0,
    remainderReserve: 0,
  };
  const rows: ModelRow[] = [];
  let emitted = 0;
  let communityStake = START_COMMUNITY_STAKE;
  let reserveBalance = START_RESERVE;
  let reserveStake = START_RESERVE * 0.8;
  let totalStakeCapacity = communityStake + reserveStake;

  for (let week = 0; week < WEEKS; week += 1) {
    const epoch = CURRENT_EPOCH + week;
    const emission = emissionForEpoch(epoch);
    const recognizedVolume = recognizedVolumeForWeek(week);
    emitted += emission;

    const projectedCirculatingBefore = projectedCirculatingFromTotals(totals);
    const stakeableCirculatingBefore = projectedCirculatingBefore * stakedCirculatingShareForWeek(week);
    const totalStakeBefore = communityStake + reserveStake;
    const activeStakeForBudget = Math.min(totalStakeBefore, stakeableCirculatingBefore);
    const stakerDesiredSharePct = saturatingShare(activeStakeForBudget, STAKER_MIN_SHARE, STAKER_MAX_SHARE, STAKE_SHARE_TARGET);
    const buyerSharePct = saturatingShare(recognizedVolume, BUYER_MIN_SHARE, BUYER_MAX_SHARE, RECOGNIZED_USDC_VOLUME_TARGET);
    const sellerSharePct = saturatingShare(recognizedVolume, SELLER_MIN_SHARE, SELLER_MAX_SHARE, RECOGNIZED_USDC_VOLUME_TARGET);

    const team = emission * TEAM_SHARE / 100;
    const baseReserve = emission * RESERVE_SHARE / 100;
    const verification = emission * VERIFICATION_SHARE / 100;
    const stakerDesired = INITIAL_EMISSION * stakerDesiredSharePct / 100;
    const stakerMaxBudget = emission * STAKER_MAX_SHARE / 100;
    const stakerGross = Math.min(stakerDesired, stakerMaxBudget);
    const stakerSharePct = emission === 0 ? 0 : stakerGross / emission * 100;
    const buyers = emission * buyerSharePct / 100;
    const sellers = emission * sellerSharePct / 100;
    const usageRemainder = emission * (BUYER_MAX_SHARE + SELLER_MAX_SHARE - buyerSharePct - sellerSharePct) / 100;
    const stakerRemainder = stakerMaxBudget - stakerGross;
    const emissionRemainder = usageRemainder + stakerRemainder;
    const burnCap = emission * EMISSION_BURN_CAP_SHARE / 100;
    const remainderBurn = Math.min(emissionRemainder, burnCap);
    const remainderReserve = emissionRemainder - remainderBurn;
    const earlyWithdrawBurn = stakerGross * EARLY_WITHDRAW_BURN_SHARE;
    const stakers = stakerGross - earlyWithdrawBurn;
    const burn = remainderBurn + earlyWithdrawBurn;

    totals.team += team;
    totals.baseReserve += baseReserve;
    totals.verification += verification;
    totals.buyers += buyers;
    totals.sellers += sellers;
    totals.stakerGross += stakerGross;
    totals.stakers += stakers;
    totals.burn += burn;
    totals.remainderBurn += remainderBurn;
    totals.earlyWithdrawBurn += earlyWithdrawBurn;
    totals.remainderReserve += remainderReserve;

    reserveBalance += baseReserve + remainderReserve;
    const progress = week / (WEEKS - 1);
    const foundationStakeShare =
      FOUNDATION_STAKE_FLOOR_SHARE +
      (FOUNDATION_STAKE_START_SHARE - FOUNDATION_STAKE_FLOOR_SHARE) * Math.pow(1 - progress, 1.35);
    const scheduledReserveStake = reserveBalance * foundationStakeShare;

    const firstYearUptake = week < 52 ? 8 * M / 52 : 0;
    const rawCommunityStake = Math.max(
      0,
      communityStake + stakers * 0.85 + sellers * 0.12 + buyers * 0.06 + firstYearUptake,
    );
    const projectedCirculatingAfter = projectedCirculatingFromTotals(totals);
    communityStake = Math.min(rawCommunityStake, projectedCirculatingAfter * stakedCirculatingShareForWeek(week + 1));
    totalStakeCapacity = Math.max(totalStakeCapacity, communityStake + scheduledReserveStake);
    reserveStake = Math.max(scheduledReserveStake, totalStakeCapacity - communityStake);

    rows.push({
      week,
      epoch,
      emission,
      emitted,
      recognizedVolume,
      projectedCirculating: projectedCirculatingAfter,
      activeStakeForBudget,
      team,
      baseReserve,
      verification,
      buyers,
      sellers,
      stakerGross,
      stakerDesired,
      stakerMaxBudget,
      stakers,
      usageRemainder,
      stakerRemainder,
      emissionRemainder,
      burn,
      remainderBurn,
      earlyWithdrawBurn,
      remainderReserve,
      communityStake,
      reserveStake,
      totalStake: communityStake + reserveStake,
      stakerSharePct,
      stakerDesiredSharePct,
      buyerSharePct,
      sellerSharePct,
      teamTotal: START_TEAM + totals.team,
      fixedReserveTotal: START_RESERVE + totals.baseReserve,
      reserveTotal: START_RESERVE + totals.baseReserve + totals.remainderReserve,
      circulating: projectedCirculatingAfter,
      stakerGrossTotal: totals.stakerGross,
      stakersTotal: totals.stakers,
      burnTotal: totals.burn,
      remainderBurnTotal: totals.remainderBurn,
      earlyWithdrawBurnTotal: totals.earlyWithdrawBurn,
      remainderReserveTotal: totals.remainderReserve,
      verificationTotal: totals.verification,
      buyersTotal: totals.buyers,
      sellersTotal: totals.sellers,
    });
  }

  return {rows, totals};
}

const MODEL = buildModel();

function fmtM(value: number, digits = 1): string {
  if (Math.abs(value) >= 1_000 * M) {
    return `${(value / (1_000 * M)).toLocaleString('en-US', {
      maximumFractionDigits: 2,
    })}B`;
  }

  return `${(value / M).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}M`;
}

function pct(value: number, digits = 1): string {
  return `${value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

function rowForWeek(week: number): ModelRow {
  return MODEL.rows.find((row) => row.week >= week) ?? MODEL.rows[MODEL.rows.length - 1];
}

function rowForYear(year: number): ModelRow {
  return rowForWeek(year * WEEKS_PER_YEAR - 1);
}

function linePoints(values: number[], maxY: number, maxX: number): string {
  const width = 560;
  const height = 300;
  const pad = {left: 54, right: 16, top: 20, bottom: 38};
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;

  return values
    .map((value, week) => {
      const x = pad.left + (week / maxX) * chartWidth;
      const y = pad.top + chartHeight - (value / maxY) * chartHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

function distributionAreaPath(lower: number[], upper: number[], maxY: number, maxX: number): string {
  const width = 820;
  const height = 360;
  const pad = {left: 58, right: 20, top: 24, bottom: 42};
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const point = (value: number, week: number) => {
    const x = pad.left + (week / maxX) * chartWidth;
    const y = pad.top + chartHeight - (value / maxY) * chartHeight;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  };
  const upperPoints = upper.map((value, week) => point(value, week));
  const lowerPoints = lower.map((value, week) => point(value, week)).reverse();

  return `M${upperPoints.join(' L')} L${lowerPoints.join(' L')} Z`;
}

function LineChart({
  title,
  subtitle,
  series,
  valueFormat = 'millions',
}: {
  title: string;
  subtitle: string;
  series: ChartSeries[];
  valueFormat?: 'millions' | 'percent';
}) {
  const width = 560;
  const height = 300;
  const pad = {left: 54, right: 16, top: 20, bottom: 38};
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const maxX = WEEKS - 1;
  const maxY = Math.max(
    1,
    ...series.flatMap((entry) => entry.values),
  ) * 1.08;

  const yTicks = Array.from({length: 5}, (_, i) => {
    const y = pad.top + chartHeight * i / 4;
    return {
      y,
      label: valueFormat === 'percent' ? pct(maxY * (1 - i / 4), 0) : fmtM(maxY * (1 - i / 4), 0),
    };
  });
  const xTicks = X_TICKS;

  return (
    <figure className={styles.chartCard}>
      <figcaption>
        <span className={styles.chartTitle}>{title}</span>
        <span className={styles.chartSubtitle}>{subtitle}</span>
      </figcaption>
      <svg className={styles.chart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}. ${subtitle}`}>
        <title>{title}</title>
        {yTicks.map((tick) => (
          <g key={tick.y}>
            <line className={styles.gridLine} x1={pad.left} y1={tick.y} x2={width - pad.right} y2={tick.y} />
            <text x="0" y={tick.y + 4}>{tick.label}</text>
          </g>
        ))}
        <line className={styles.axis} x1={pad.left} y1={pad.top + chartHeight} x2={width - pad.right} y2={pad.top + chartHeight} />
        <line className={styles.axis} x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + chartHeight} />
        {xTicks.map((tick) => {
          const x = pad.left + (tick.week / maxX) * chartWidth;
          return (
            <g key={tick.week}>
              <line className={styles.gridLine} x1={x} y1={pad.top} x2={x} y2={pad.top + chartHeight} />
              <text textAnchor="middle" x={x} y={height - 12}>{tick.label}</text>
            </g>
          );
        })}
        {series.map((entry) => (
          <polyline
            key={entry.label}
            className={styles.seriesLine}
            points={linePoints(entry.values, maxY, maxX)}
            stroke={entry.color}
            strokeDasharray={entry.dashed ? '5 6' : undefined}
          />
        ))}
      </svg>
      <div className={styles.legend}>
        {series.map((entry) => (
          <span key={entry.label}>
            <i style={{background: entry.color}} />
            {entry.label}
          </span>
        ))}
      </div>
      <p className={styles.projectionNote}>{PROJECTION_NOTE}</p>
    </figure>
  );
}

function StackedDistributionChart({series}: {series: DistributionSeries[]}) {
  const width = 820;
  const height = 360;
  const pad = {left: 58, right: 20, top: 24, bottom: 42};
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const maxX = WEEKS - 1;
  const maxY = series.reduce((sum, entry) => sum + entry.values[entry.values.length - 1], 0);
  const cumulative = Array.from({length: WEEKS}, () => 0);
  const xTicks = X_TICKS;
  const yTicks = Array.from({length: 5}, (_, i) => {
    const y = pad.top + chartHeight * i / 4;
    return {
      y,
      label: fmtM(maxY * (1 - i / 4), 0),
    };
  });

  const layers = series.map((entry) => {
    const lower = cumulative.slice();
    entry.values.forEach((value, index) => {
      cumulative[index] += value;
    });

    return {
      ...entry,
      lower,
      upper: cumulative.slice(),
      final: entry.values[entry.values.length - 1],
    };
  });

  return (
    <figure className={`${styles.chartCard} ${styles.distributionCard}`}>
      <figcaption>
        <span className={styles.chartTitle}>Full emission distribution over time</span>
        <span className={styles.chartSubtitle}>Cumulative view from genesis; first epochs are folded into their emitted seller, buyer, Foundation, and contributor buckets.</span>
      </figcaption>
      <svg className={styles.distributionChart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Full cumulative emission distribution over time with burn trace">
        <title>Full cumulative emission distribution over time</title>
        {yTicks.map((tick) => (
          <g key={tick.y}>
            <line className={styles.gridLine} x1={pad.left} y1={tick.y} x2={width - pad.right} y2={tick.y} />
            <text x="0" y={tick.y + 4}>{tick.label}</text>
          </g>
        ))}
        <line className={styles.axis} x1={pad.left} y1={pad.top + chartHeight} x2={width - pad.right} y2={pad.top + chartHeight} />
        <line className={styles.axis} x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + chartHeight} />
        {xTicks.map((tick) => {
          const x = pad.left + (tick.week / maxX) * chartWidth;
          return (
            <g key={tick.week}>
              <line className={styles.gridLine} x1={x} y1={pad.top} x2={x} y2={pad.top + chartHeight} />
              <text textAnchor="middle" x={x} y={height - 13}>{tick.label}</text>
            </g>
          );
        })}
        {layers.map((layer) => (
          <path
            key={layer.label}
            className={styles.areaLayer}
            d={distributionAreaPath(layer.lower, layer.upper, maxY, maxX)}
            fill={layer.color}
          />
        ))}
      </svg>
      <div className={styles.legend}>
        {layers.map((entry) => (
          <span key={entry.label}>
            <i style={{background: entry.color}} />
            {entry.label}
          </span>
        ))}
      </div>
      <p className={styles.projectionNote}>{PROJECTION_NOTE}</p>
    </figure>
  );
}

function WeeklyEmissionStackedAreas() {
  const width = 820;
  const height = 340;
  const pad = {left: 56, right: 18, top: 20, bottom: 42};
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const rows = MODEL.rows;
  const maxY = INITIAL_EMISSION;
  const yFor = (value: number) => pad.top + chartHeight - (value / maxY) * chartHeight;
  const segments = [
    {label: 'Unused budget -> Foundation', color: COLORS.remainderReserve, get: (row: ModelRow) => row.remainderReserve},
    {label: 'Unused budget -> burned', color: COLORS.remainderBurn, get: (row: ModelRow) => row.remainderBurn},
    {label: 'Exit burn', color: COLORS.exitBurn, get: (row: ModelRow) => row.earlyWithdrawBurn},
    {label: 'Stakers', color: COLORS.stakers, get: (row: ModelRow) => row.stakers},
    {label: 'Sellers', color: COLORS.sellers, get: (row: ModelRow) => row.sellers},
    {label: 'Buyers', color: COLORS.buyers, get: (row: ModelRow) => row.buyers},
    {label: 'Verification', color: COLORS.verification, get: (row: ModelRow) => row.verification},
    {label: 'Antseed Foundation', color: COLORS.reserve, get: (row: ModelRow) => row.baseReserve},
    {label: 'Contributors', color: COLORS.team, get: (row: ModelRow) => row.team},
  ];
  const cumulative = rows.map(() => 0);
  const layers = segments.map((segment) => {
    const lower = cumulative.slice();
    rows.forEach((row, index) => {
      cumulative[index] += segment.get(row);
    });

    return {
      ...segment,
      lower,
      upper: cumulative.slice(),
    };
  });
  const xTicks = X_TICKS;
  const yTicks = [5 * M, 4 * M, 3 * M, 2 * M, 1 * M, 0];
  const point = (value: number, week: number) => {
    const x = pad.left + (week / (WEEKS - 1)) * chartWidth;
    const y = yFor(value);

    return `${x.toFixed(2)},${y.toFixed(2)}`;
  };
  const areaPath = (lower: number[], upper: number[]) => {
    const upperPoints = upper.map((value, week) => point(value, week));
    const lowerPoints = lower.map((value, week) => point(value, week)).reverse();

    return `M${upperPoints.join(' L')} L${lowerPoints.join(' L')} Z`;
  };

  return (
    <figure className={styles.chartCard}>
      <figcaption>
        <span className={styles.chartTitle}>Weekly emission routing</span>
        <span className={styles.chartSubtitle}>The filled bands start from the full weekly emission. Dynamic-budget remainders route through burn first, then the Antseed Foundation.</span>
      </figcaption>
      <svg className={styles.distributionChart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Weekly emission routing as stacked areas">
        <title>Weekly emission routing as stacked areas</title>
        {yTicks.map((tick) => {
          const y = yFor(tick);
          return (
            <g key={tick}>
              <line className={styles.gridLine} x1={pad.left} y1={y} x2={width - pad.right} y2={y} />
              <text x="0" y={y + 4}>{fmtM(tick, 0)}</text>
            </g>
          );
        })}
        <line className={styles.axis} x1={pad.left} y1={pad.top + chartHeight} x2={width - pad.right} y2={pad.top + chartHeight} />
        <line className={styles.axis} x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + chartHeight} />
        {xTicks.map((tick) => {
          const x = pad.left + (tick.week / (WEEKS - 1)) * chartWidth;
          return (
            <g key={tick.week}>
              <line className={styles.gridLine} x1={x} y1={pad.top} x2={x} y2={pad.top + chartHeight} />
              <text textAnchor="middle" x={x} y={height - 13}>{tick.label}</text>
            </g>
          );
        })}
        {layers.map((layer) => (
          <path
            key={layer.label}
            className={styles.emissionAreaLayer}
            d={areaPath(layer.lower, layer.upper)}
            fill={layer.color}
          />
        ))}
      </svg>
      <div className={styles.legend}>
        {segments.map((segment) => (
          <span key={segment.label}>
            <i style={{background: segment.color}} />
            {segment.label}
          </span>
        ))}
      </div>
      <p className={styles.projectionNote}>{PROJECTION_NOTE}</p>
    </figure>
  );
}

export function SellerPoolsOverviewChart() {
  const rows = MODEL.rows;

  return (
    <StackedDistributionChart
      series={[
        {label: 'Unused budget -> Foundation', color: COLORS.remainderReserve, values: rows.map((row) => row.remainderReserveTotal)},
        {label: 'Unused budget -> burned', color: COLORS.remainderBurn, values: rows.map((row) => row.remainderBurnTotal)},
        {label: 'Exit burn', color: COLORS.exitBurn, values: rows.map((row) => row.earlyWithdrawBurnTotal)},
        {label: 'Stakers', color: COLORS.stakers, values: rows.map((row) => row.stakersTotal)},
        {label: 'Sellers', color: COLORS.sellers, values: rows.map((row) => ALREADY_EMITTED_SELLERS + row.sellersTotal)},
        {label: 'Buyers', color: COLORS.buyers, values: rows.map((row) => ALREADY_EMITTED_BUYERS + row.buyersTotal)},
        {label: 'Verification', color: COLORS.verification, values: rows.map((row) => row.verificationTotal)},
        {label: 'Antseed Foundation', color: COLORS.reserve, values: rows.map((row) => ALREADY_EMITTED_RESERVE + row.fixedReserveTotal - START_RESERVE)},
        {label: 'Contributors', color: COLORS.team, values: rows.map((row) => ALREADY_EMITTED_TEAM + row.teamTotal - START_TEAM)},
      ]}
    />
  );
}

export function SellerPoolsAllocationChart() {
  return (
    <figure className={styles.ledgerCard}>
      <figcaption>
        <span className={styles.chartTitle}>Emission range ledger</span>
        <span className={styles.chartSubtitle}>Contracts keep fixed buckets, then size seller-pool and usage budgets inside configured ranges; usage ranges target $1M settled USDC per epoch.</span>
      </figcaption>
      <div className={styles.barList}>
        {EMISSION_LEDGER.map((allocation) => (
          <div className={styles.barRow} key={allocation.label}>
            <span>{allocation.label}</span>
            <div className={styles.barTrack}>
              <div
                className={styles.barFill}
                style={{
                  width: `${allocation.shareValue / 45 * 100}%`,
                  background: allocation.color,
                }}
              />
            </div>
            <strong>{allocation.shareLabel}</strong>
          </div>
        ))}
      </div>
      <p className={styles.formula}>
        Fixed: 15 contributors + 15 Antseed Foundation + 10 verification. Dynamic: stakers 2-40, buyers 5-10, sellers/operators 5-10, with usage ranges based on recognized settled USDC volume.
      </p>
      <p className={styles.projectionNote}>{PROJECTION_NOTE}</p>
    </figure>
  );
}

export function SellerPoolsWeeklyRoutingChart() {
  const rows = MODEL.rows;

  return (
    <div className={styles.figureGroup}>
      <LineChart
        title="Weekly seller-pool range routing"
        subtitle="The staker budget uses active stake capped by projected circulating participation, then clamps to the current 40% controller cap after halvings."
        series={[
          {label: '40% max', color: COLORS.gray, values: rows.map((row) => row.emission * STAKER_MAX_SHARE / 100), dashed: true},
          {label: 'Stakers', color: COLORS.stakers, values: rows.map((row) => row.stakers)},
          {label: 'Target amount', color: COLORS.sellers, values: rows.map((row) => row.stakerDesired), dashed: true},
          {label: 'Unused budget -> burned', color: COLORS.remainderBurn, values: rows.map((row) => Math.min(row.stakerRemainder, row.emission * EMISSION_BURN_CAP_SHARE / 100))},
          {label: 'Exit burn', color: COLORS.exitBurn, values: rows.map((row) => row.earlyWithdrawBurn)},
          {label: 'Unused budget -> Foundation', color: COLORS.remainderReserve, values: rows.map((row) => Math.max(0, row.stakerRemainder - row.emission * EMISSION_BURN_CAP_SHARE / 100))},
        ]}
      />
    </div>
  );
}

export function SellerPoolsBurnChart() {
  return (
    <div className={styles.figureGroup}>
      <WeeklyEmissionStackedAreas />
    </div>
  );
}

function Metric({label, value, note}: {label: string; value: string; note: string}) {
  return (
    <div className={styles.metric}>
      <strong>{value}</strong>
      <span>{label}</span>
      <p>{note}</p>
    </div>
  );
}
