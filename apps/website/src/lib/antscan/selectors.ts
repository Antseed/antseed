import type {EmissionsResponse, TotalsResponse} from './api.ts';
import type {AntsToken, NetworkTotals} from './types.ts';

/** 18-decimal base units (decimal or 0x hex) → whole tokens, through bigint so nothing is lost before the last six decimals. */
export const fromWei = (units: string): number => Number(BigInt(units) / 10n ** 12n) / 1e6;

const sum = (...counters: string[]): number => counters.reduce((total, c) => total + Number(c), 0);
const positive = (...values: number[]): boolean => values.every((v) => Number.isFinite(v) && v > 0);

/**
 * Lifetime figures. Antscan's `total*` counters are the paid, settled ones (the indexer's networkSnapshot, as GraphQL returns
 * it); `free*` are buyer-reported free-tier usage, counted apart, so served requests and tokens are their sum.
 * null when the answer is empty or malformed.
 */
export function selectTotals(res: TotalsResponse): NetworkTotals | null {
  const totals: NetworkTotals = {
    users: res.buyerCount,
    providers: res.sellerCount,
    requests: sum(res.totalRequests, res.freeRequests),
    tokens: sum(res.totalInputTokens, res.totalOutputTokens, res.freeInputTokens, res.freeOutputTokens),
    settledUsd: Number(res.totalVolumeUsdc) / 1e6,
  };
  return positive(...Object.values(totals)) ? totals : null;
}

/** Supply, burned and the emission clock. `burnedHex` is the raw balanceOf(0x…dEaD) answer. */
export function selectAnts(res: EmissionsResponse, burnedHex: string): AntsToken | null {
  try {
    const ants: AntsToken = {
      supply: fromWei(res.mintedSupply),
      burned: fromWei(burnedHex),
      epoch: Number(res.currentEpoch),
      epochEndsAt: Number(res.epochProgress.endsAt),
      epochSeconds: Number(res.epochDuration),
    };
    return positive(ants.supply, ants.epochEndsAt, ants.epochSeconds) && Number.isInteger(ants.epoch) && ants.burned >= 0 ? ants : null;
  } catch {
    return null;
  }
}

export type EpochClock = {epoch: number; secondsLeft: number};

/** The epoch at `nowSeconds`, carried past `epochEndsAt` by whole epochs when the read is older than the turn. */
export function epochAt(ants: AntsToken, nowSeconds: number): EpochClock {
  const passed = Math.max(0, Math.floor((nowSeconds - ants.epochEndsAt) / ants.epochSeconds) + 1);
  const endsAt = ants.epochEndsAt + passed * ants.epochSeconds;
  return {epoch: ants.epoch + passed, secondsLeft: Math.max(0, endsAt - nowSeconds)};
}

/** "Next epoch in 3d 4h 5m". */
export const formatCountdown = (s: number): string =>
  `Next epoch in ${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h ${Math.floor(s / 60) % 60}m`;
