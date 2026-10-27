/**
 * Coarse buckets: the only form durations, counts and amounts take in
 * telemetry. Exact values stay on the device.
 */

export type DurationBucket = 'under_30s' | '30s_2m' | '2m_5m' | 'over_5m';
export type CountBucket = '0' | '1' | '2_5' | '6_20' | '21_plus';
export type SmallCountBucket = '0' | '1' | '2_3' | '4_plus';
export type AttemptCountBucket = '1' | '2' | '3_plus';
export type SellersTriedBucket = '0' | '1' | '2' | '3_plus';
export type TtftBucket = 'none' | 'under_1s' | '1_3s' | '3_10s' | 'over_10s';
export type RequestDurationBucket = 'under_1s' | '1_5s' | '5_30s' | '30s_2m' | 'over_2m';
/** USDC amount buckets, from integer base units (6 decimals). */
export type UsdcAmountBucket = 'zero' | 'under_0_01' | '0_01_0_1' | '0_1_1' | '1_10' | 'over_10';

export const DURATION_BUCKETS: ReadonlySet<string> = new Set(['under_30s', '30s_2m', '2m_5m', 'over_5m']);
export const COUNT_BUCKETS: ReadonlySet<string> = new Set(['0', '1', '2_5', '6_20', '21_plus']);
export const SMALL_COUNT_BUCKETS: ReadonlySet<string> = new Set(['0', '1', '2_3', '4_plus']);
export const ATTEMPT_COUNT_BUCKETS: ReadonlySet<string> = new Set(['1', '2', '3_plus']);
export const SELLERS_TRIED_BUCKETS: ReadonlySet<string> = new Set(['0', '1', '2', '3_plus']);
export const TTFT_BUCKETS: ReadonlySet<string> = new Set(['none', 'under_1s', '1_3s', '3_10s', 'over_10s']);
export const REQUEST_DURATION_BUCKETS: ReadonlySet<string> = new Set(['under_1s', '1_5s', '5_30s', '30s_2m', 'over_2m']);
export const USDC_AMOUNT_BUCKETS: ReadonlySet<string> = new Set(['zero', 'under_0_01', '0_01_0_1', '0_1_1', '1_10', 'over_10']);
export function durationBucket(ms: number): DurationBucket {
  if (ms < 30_000) return 'under_30s';
  if (ms < 2 * 60_000) return '30s_2m';
  if (ms < 5 * 60_000) return '2m_5m';
  return 'over_5m';
}

export function countBucket(count: number): CountBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 20) return '6_20';
  return '21_plus';
}

export function smallCountBucket(count: number): SmallCountBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2_3';
  return '4_plus';
}

export function attemptCountBucket(attempts: number): AttemptCountBucket {
  if (attempts <= 1) return '1';
  if (attempts === 2) return '2';
  return '3_plus';
}

export function sellersTriedBucket(count: number): SellersTriedBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count === 2) return '2';
  return '3_plus';
}

export function ttftBucket(ms: number | null): TtftBucket {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'none';
  if (ms < 1_000) return 'under_1s';
  if (ms < 3_000) return '1_3s';
  if (ms < 10_000) return '3_10s';
  return 'over_10s';
}

export function requestDurationBucket(ms: number): RequestDurationBucket {
  if (!Number.isFinite(ms) || ms < 1_000) return 'under_1s';
  if (ms < 5_000) return '1_5s';
  if (ms < 30_000) return '5_30s';
  if (ms < 2 * 60_000) return '30s_2m';
  return 'over_2m';
}

/** Buckets a USDC amount given as integer base units (6 decimals). Never a float. */
export function usdcAmountBucket(baseUnits: bigint): UsdcAmountBucket {
  if (baseUnits <= 0n) return 'zero';
  if (baseUnits < 10_000n) return 'under_0_01';
  if (baseUnits < 100_000n) return '0_01_0_1';
  if (baseUnits < 1_000_000n) return '0_1_1';
  if (baseUnits < 10_000_000n) return '1_10';
  return 'over_10';
}

/** HTTP status as sent: an integer in 100–599, else undefined. */
export function telemetryHttpStatus(statusCode: number | undefined): number | undefined {
  return typeof statusCode === 'number' && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : undefined;
}
