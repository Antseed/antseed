// View models the pages render from: Antscan reads + a handful of chain reads,
// turned into points, boosts and estimates by ./points.
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { antscan, type Pool, type Position } from './antscan';
import { readAntsBalance, readBuyerPots, readOperator, readPendingBuyer, readPendingStaker, readTransfersEnabled, readUsagePots } from './chain';
import {
  MAX_LOCK_EPOCHS,
  antsFromWei,
  antsPerPoint,
  blendedStakerEstimate,
  boostFromWeight,
  epochAt,
  epochEndMs,
  pointsFromWeighted,
  scaled,
  usageReward,
  usdFromUsdc,
} from './points';

/** First epoch paid under recognized usage (Sep 10 2026). */
export const FIRST_REWARDED_EPOCH = 22;

export interface ModelOffer {
  id: string;
  name: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Free models cost nothing, so they earn no points. */
  free: boolean;
}

export interface Provider {
  agentId: string;
  seller: string;
  name: string;
  models: string[];
  /** Models this provider serves, paid ones first (cheapest first), then free ones. */
  offers: ModelOffer[];
  boost: number;
  boostLast: number;
  stakeAnts: number;
  pendingStakeAnts: number;
  volumeUsd: number;
  volumeLastUsd: number;
  /** Points this provider's buyers earned this epoch (= the provider's own points). */
  points: number;
  /** Estimated buyer ANTS per $1 here, at the current rate. */
  antsPerUsd: number;
  /** Estimated weekly ANTS for 1,000 ANTS max-locked behind this provider. */
  stakerPer1k: number;
  /** Share of all pool power that is locked long: power / (stake × 104). */
  lockStrength: number;
  /** This provider's own share of the provider pot is above the 5% claim cap. */
  providerCapped: boolean;
}

export interface Network {
  epoch: number;
  asOfBlock: number;
  pots: { buyer: number; seller: number; staker: number };
  lastPots: { buyer: number; seller: number; staker: number };
  volumeUsd: number;
  requests: number;
  /** Buyers who have earned points this epoch so far. */
  buyersThisEpoch: number | null;
  totalStakeAnts: number;
  totalPoolWeighted: string;
  /** Last week's Σ provider volume × pool power, for steadier staker estimates early in the week. */
  lastTotalPoolWeighted: string;
  /** How far through the week we are, 0 → 1. */
  weekFraction: number;
  totalBuyerWeighted: string;
  lastTotalBuyerWeighted: string;
  /** ANTS per buyer point so far this epoch (estimate until the epoch ends). */
  rate: number;
  /** Final ANTS per buyer point last epoch. */
  lastRate: number;
  providers: Provider[];
  /** Display name for every seller address we know, including ones with no stake or volume. */
  sellerNames: Record<string, string>;
}

function providerName(pool: Pool, names: Map<string, string>): string {
  return pool.sellerName || names.get(pool.seller.toLowerCase()) || `Agent ${pool.agentId}`;
}

export async function loadNetwork(): Promise<Network> {
  const [pools, market] = await Promise.all([antscan.pools(), antscan.marketplace().catch(() => ({ sellers: [], offerings: [] }))]);
  const epoch = Number(pools.currentEpoch) || epochAt(Date.now());
  const buyersThisEpoch = await antscan.buyerCount(epoch).catch(() => null);
  const cur = pools.network.current;
  const last = pools.network.last;
  const [potsNow, potsLast] = await Promise.all([readUsagePots(epoch), readUsagePots(epoch - 1)]);

  const names = new Map(market.sellers.map((s) => [s.address.toLowerCase(), s.name ?? '']));
  const models = new Map(market.sellers.map((s) => [s.address.toLowerCase(), s.services ?? []]));
  const offers = new Map<string, ModelOffer[]>();
  for (const o of market.offerings) {
    const key = o.sellerAddress.toLowerCase();
    const list = offers.get(key) ?? [];
    const display = o.serviceDisplayName || o.service;
    const free = !Number(o.inputUsdPerMillion) && !Number(o.outputUsdPerMillion);
    // The same model can be listed under several ids (provider plugins, aliases): keep one row per name and pricing kind.
    if (list.some((x) => x.id === o.service || (x.name === display && x.free === free))) continue;
    list.push({
      id: o.service,
      name: display,
      inputUsdPerMillion: Number(o.inputUsdPerMillion) || 0,
      outputUsdPerMillion: Number(o.outputUsdPerMillion) || 0,
      free,
    });
    offers.set(key, list);
  }
  for (const list of offers.values()) {
    list.sort((a, b) => Number(a.free) - Number(b.free) || a.inputUsdPerMillion + a.outputUsdPerMillion - (b.inputUsdPerMillion + b.outputUsdPerMillion));
  }

  const pots = { buyer: antsFromWei(potsNow.buyerPot), seller: antsFromWei(potsNow.sellerPot), staker: antsFromWei(cur?.stakerBudget) };
  const lastPots = { buyer: antsFromWei(potsLast.buyerPot), seller: antsFromWei(potsLast.sellerPot), staker: antsFromWei(last?.stakerBudget) };
  const rate = antsPerPoint(pots.buyer, cur?.totalWeightedBuyerPoints);
  const totalPoolWeighted = cur?.totalWeightedPoolPoints ?? '0';
  const lastTotalPoolWeighted = last?.totalWeightedPoolPoints ?? '0';
  const weekFraction = Math.min(1, Math.max(0, 1 - (epochEndMs(epoch) - Date.now()) / (7 * 86_400_000)));
  const totalPoolW = scaled(totalPoolWeighted, 24);

  const providers: Provider[] = pools.pools
    // Antscan's `registered` flag doesn't affect points: unregistered pools earn their boost too
    // (Venice.ai Proxy's buyers earned 4.48× on epoch 27), so every pool with stake or volume is listed.
    .filter((p) => Boolean(p.seller))
    .map((p) => {
      const boost = boostFromWeight(p.weight);
      const stakeAnts = antsFromWei(p.activeStake);
      const volumeUsd = usdFromUsdc(p.volumeUsdc);
      const share = totalPoolW > 0 ? scaled(p.weightedUsagePoints, 24) / totalPoolW : 0;
      return {
        agentId: p.agentId,
        seller: p.seller,
        name: providerName(p, names),
        models: models.get(p.seller.toLowerCase()) ?? [],
        offers: offers.get(p.seller.toLowerCase()) ?? [],
        boost,
        boostLast: boostFromWeight(p.lastWeight),
        stakeAnts,
        pendingStakeAnts: antsFromWei(p.pendingStake),
        volumeUsd,
        volumeLastUsd: usdFromUsdc(p.lastVolumeUsdc),
        points: pointsFromWeighted(p.weightedUsagePoints),
        antsPerUsd: boost * rate,
        stakerPer1k: blendedStakerEstimate({ stakerPotAnts: pots.staker, stakeAnts: 1000, lockEpochs: MAX_LOCK_EPOCHS, volumeUsd, totalPoolWeighted, lastVolumeUsd: usdFromUsdc(p.lastVolumeUsdc), lastTotalPoolWeighted, weekFraction }),
        lockStrength: stakeAnts > 0 ? Math.min(1, antsFromWei(p.weight) / (stakeAnts * MAX_LOCK_EPOCHS)) : 0,
        providerCapped: share > 0.05,
      };
    })
    .filter((p) => p.stakeAnts > 0 || p.volumeUsd > 0 || p.volumeLastUsd > 0);

  return {
    epoch,
    asOfBlock: cur?.lastBlockNumber ?? 0,
    pots,
    lastPots,
    volumeUsd: usdFromUsdc(cur?.volumeUsdc),
    requests: Number(cur?.requests ?? 0),
    buyersThisEpoch,
    totalStakeAnts: antsFromWei(cur?.totalActiveStake),
    totalPoolWeighted,
    lastTotalPoolWeighted,
    weekFraction,
    totalBuyerWeighted: cur?.totalWeightedBuyerPoints ?? '0',
    lastTotalBuyerWeighted: last?.totalWeightedBuyerPoints ?? '0',
    rate,
    lastRate: antsPerPoint(lastPots.buyer, last?.totalWeightedBuyerPoints),
    providers,
    sellerNames: Object.fromEntries([
      ...[...names].filter(([, n]) => n),
      // Some pools have no seller address yet; skip them rather than fail the whole load.
      ...pools.pools.filter((p) => p.seller).map((p) => [p.seller.toLowerCase(), providerName(p, names)] as const),
    ]),
  };
}

export function useNetwork() {
  return useQuery({ queryKey: ['network'], queryFn: loadNetwork, refetchInterval: 60_000, staleTime: 30_000 });
}

export interface EpochRow {
  epoch: number;
  spentUsd: number;
  points: number;
  /** Estimated (current epoch) or contract-reported (finished epochs) ANTS. */
  ants: number;
  capped: boolean;
  /** Finished, unclaimed and claimable now. */
  claimable: bigint;
  current: boolean;
}

export interface StakeRow {
  id: string;
  agentId: string;
  provider: string;
  amountAnts: number;
  startEpoch: number;
  endEpoch: number;
  maxLocked: boolean;
  powerAnts: number;
  /** Created this epoch; counts from the next one. */
  pending: boolean;
  estWeekAnts: number;
  pendingAnts: number;
}

export interface Account {
  address: Address;
  operator: Address | null;
  epochs: EpochRow[];
  pointsNow: number;
  estAntsNow: number;
  claimableTotal: bigint;
  claimableEpochs: number[];
  stakes: StakeRow[];
  stakedAnts: number;
  balanceAnts: number;
  transfersEnabled: boolean;
  /** Provider points if this address is also a seller. */
  providerPointsNow: number;
  /** This epoch's raw weighted buyer points (USDC × power), for exact ranking. */
  buyerWeightedNow: string;
  /** Total spent across every rewarded epoch so far. */
  spentTotalUsd: number;
}

const ZERO = '0x0000000000000000000000000000000000000000';

export async function loadAccount(address: Address, net: Network): Promise<Account> {
  const finished: number[] = [];
  for (let e = FIRST_REWARDED_EPOCH; e < net.epoch; e++) finished.push(e);
  const [participant, positions, operator, pending, balance, transfersEnabled, netEpochs, pastPots] = await Promise.all([
    antscan.participant(address, net.epoch - FIRST_REWARDED_EPOCH + 1),
    antscan.positions(address).catch(() => ({ positions: [] as Position[] })),
    readOperator(address).catch(() => ZERO as Address),
    readPendingBuyer(address, finished).catch(() => new Map<number, bigint>()),
    readAntsBalance(address).catch(() => ({ balance: 0n, allowance: 0n })),
    readTransfersEnabled().catch(() => false),
    antscan.epochs(net.epoch - FIRST_REWARDED_EPOCH + 3).catch(() => []),
    readBuyerPots(finished).catch(() => new Map<number, bigint>()),
  ]);
  const totals = new Map(netEpochs.map((n) => [Number(n.epoch), n.totalWeightedBuyerPoints]));

  const byEpoch = new Map(participant.buyer.map((b) => [Number(b.epoch), b]));
  const epochs: EpochRow[] = [];
  for (let e = FIRST_REWARDED_EPOCH; e <= net.epoch; e++) {
    const row = byEpoch.get(e);
    const current = e === net.epoch;
    const claimable = pending.get(e) ?? 0n;
    const est = current
      ? usageReward(net.pots.buyer, row?.weightedPoints, net.totalBuyerWeighted)
      : usageReward(antsFromWei(pastPots.get(e) ?? 0n), row?.weightedPoints, totals.get(e));
    epochs.push({
      epoch: e,
      spentUsd: usdFromUsdc(row?.volumeUsdc),
      points: pointsFromWeighted(row?.weightedPoints),
      ants: est.ants,
      capped: est.capped,
      claimable: current ? 0n : claimable,
      current,
    });
  }
  const now = epochs.at(-1)!;

  const open = positions.positions.filter((p) => !p.withdrawn && !Number(p.closedAtEpoch ?? 0));
  const stakerPending = await readPendingStaker(open.map((p) => p.id), finished.slice(-4)).catch(() => new Map<string, bigint>());
  const provById = new Map(net.providers.map((p) => [p.agentId, p]));
  const stakes: StakeRow[] = open.map((p) => {
    const prov = provById.get(String(p.agentId));
    const amountAnts = antsFromWei(p.amount);
    const end = Number(p.stakeEndEpoch);
    const lock = p.maxLocked ? MAX_LOCK_EPOCHS : Math.max(0, end - net.epoch);
    const powerAnts = antsFromWei(p.power && p.power !== '0' ? p.power : p.nextPower) || amountAnts * lock;
    return {
      id: String(p.id),
      agentId: String(p.agentId),
      provider: prov?.name ?? `Agent ${p.agentId}`,
      amountAnts,
      startEpoch: Number(p.stakeStartEpoch),
      endEpoch: end,
      maxLocked: Boolean(p.maxLocked),
      powerAnts,
      pending: p.state === 'pending',
      estWeekAnts: blendedStakerEstimate({ stakerPotAnts: net.pots.staker, stakeAnts: powerAnts / MAX_LOCK_EPOCHS, lockEpochs: MAX_LOCK_EPOCHS, volumeUsd: prov?.volumeUsd ?? 0, totalPoolWeighted: net.totalPoolWeighted, lastVolumeUsd: prov?.volumeLastUsd ?? 0, lastTotalPoolWeighted: net.lastTotalPoolWeighted, weekFraction: net.weekFraction }),
      pendingAnts: antsFromWei(stakerPending.get(String(p.id)) ?? 0n),
    };
  });

  const sellerNow = participant.seller.find((s) => Number(s.epoch) === net.epoch);
  const claimableEpochs = epochs.filter((e) => e.claimable > 0n).map((e) => e.epoch);
  return {
    address,
    operator: operator && operator !== ZERO ? operator : null,
    epochs,
    pointsNow: now.points,
    estAntsNow: now.ants,
    claimableTotal: epochs.reduce((a, e) => a + e.claimable, 0n),
    claimableEpochs,
    stakes,
    stakedAnts: stakes.reduce((a, s) => a + s.amountAnts, 0),
    balanceAnts: antsFromWei(balance.balance),
    transfersEnabled,
    providerPointsNow: pointsFromWeighted(sellerNow?.weightedPoints),
    buyerWeightedNow: byEpoch.get(net.epoch)?.weightedPoints ?? '0',
    spentTotalUsd: epochs.reduce((t, e) => t + e.spentUsd, 0),
  };
}

export function useAccount(address: Address | null, net: Network | undefined) {
  return useQuery({
    queryKey: ['account', address, net?.epoch, net?.asOfBlock],
    queryFn: () => loadAccount(address!, net!),
    enabled: Boolean(address && net),
    staleTime: 30_000,
  });
}

export interface SettlementRow {
  tx: string;
  buyer: string;
  provider: string;
  usd: number;
  boost: number;
  points: number;
  timestamp: number;
}

/** The latest settlements, each with the points it earned its buyer ($ × the provider's boost now). */
export function useSettlements(net: Network | undefined, limit = 12) {
  return useQuery({
    queryKey: ['settlements', limit, net?.epoch],
    enabled: Boolean(net),
    refetchInterval: 30_000,
    queryFn: async (): Promise<SettlementRow[]> => {
      const rows = await antscan.recentSettlements(limit);
      const bySeller = new Map(net!.providers.map((p) => [p.seller.toLowerCase(), p]));
      return rows.map((r) => {
        const p = bySeller.get(r.seller.toLowerCase());
        const boost = p && p.boost >= 0.01 ? p.boost : 0;
        const usd = usdFromUsdc(r.deltaUsdc);
        const name = p?.name ?? net!.sellerNames[r.seller.toLowerCase()] ?? `${r.seller.slice(0, 6)}…${r.seller.slice(-4)}`;
        return { tx: r.txHash, buyer: r.buyer, provider: name, usd, boost, points: usd * boost, timestamp: r.timestamp };
      });
    },
  });
}

export interface WeekRow {
  epoch: number;
  startMs: number;
  endMs: number;
  spentUsd: number;
  points: number;
  pot: number;
  /** ANTS per point: final for finished weeks, so far for the live one. */
  rate: number;
  live: boolean;
}

/** The last few weeks' ANTS per point, oldest first, ending with this week. */
export function useWeeks(net: Network | undefined, count = 4) {
  return useQuery({
    queryKey: ['weeks', net?.epoch, count],
    enabled: Boolean(net),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<WeekRow[]> => {
      const epochs = await antscan.epochs(count + 2);
      const finished = epochs.map((e) => Number(e.epoch)).filter((e) => e < net!.epoch && e >= FIRST_REWARDED_EPOCH).sort((a, b) => a - b).slice(-(count - 1));
      const pots = await readBuyerPots(finished);
      const byEpoch = new Map(epochs.map((e) => [Number(e.epoch), e]));
      const row = (epoch: number, live: boolean): WeekRow => {
        const e = byEpoch.get(epoch);
        const points = live ? pointsFromWeighted(net!.totalBuyerWeighted) : pointsFromWeighted(e?.totalWeightedBuyerPoints);
        const pot = live ? net!.pots.buyer : antsFromWei(pots.get(epoch) ?? 0n);
        const endMs = epochEndMs(epoch);
        return { epoch, startMs: endMs - 7 * 86_400_000, endMs, spentUsd: live ? net!.volumeUsd : usdFromUsdc(e?.volumeUsdc), points, pot, rate: points > 0 ? pot / points : 0, live };
      };
      return [...finished.map((e) => row(e, false)), row(net!.epoch, true)];
    },
  });
}

export interface WeekPace {
  elapsedMs: number;
  leftMs: number;
  /** Everyone's points per day on a busy day: the busiest of the last 14 full days' spending × this week's average boost. */
  busyPointsPerDay: number;
}

/** How far through the week we are, and how fast points can pile up, for the "likely by Thursday" range. */
export function useWeekPace(net: Network | undefined, now: number): WeekPace | null {
  const daily = useQuery({ queryKey: ['daily-volume'], queryFn: () => antscan.dailyVolume(15), staleTime: 30 * 60_000, enabled: Boolean(net) });
  if (!net) return null;
  const end = epochEndMs(net.epoch);
  const start = end - 7 * 86_400_000;
  const points = pointsFromWeighted(net.totalBuyerWeighted);
  // Average boost this week: points per dollar spent so far.
  const avgBoost = net.volumeUsd > 0 ? points / net.volumeUsd : 0;
  const today = Math.floor(now / 86_400_000) * 86_400;
  const fullDays = (daily.data ?? []).filter((d) => d.dayStart < today).slice(0, 14);
  const busiestUsd = Math.max(0, ...fullDays.map((d) => usdFromUsdc(d.volumeUsdc)));
  return { elapsedMs: Math.max(0, now - start), leftMs: Math.max(0, end - now), busyPointsPerDay: busiestUsd * avgBoost };
}
