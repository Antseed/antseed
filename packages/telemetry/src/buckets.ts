/**
 * Coarse buckets for the counts, durations and amounts that are sent as a
 * range, not an exact value (for example a deposit amount). Request timings
 * and token counts are sent exactly; see docs/telemetry.md.
 */

export type DurationBucket = 'under_30s' | '30s_2m' | '2m_5m' | 'over_5m';
export type CountBucket = '0' | '1' | '2_5' | '6_20' | '21_plus';
export type SmallCountBucket = '0' | '1' | '2_3' | '4_plus';
export type AttemptCountBucket = '1' | '2' | '3_plus';
export type SellersTriedBucket = '0' | '1' | '2' | '3_plus';
/** USDC amount buckets, from integer base units (6 decimals). */
export type UsdcAmountBucket = 'zero' | 'under_0_01' | '0_01_0_1' | '0_1_1' | '1_10' | 'over_10';

export const DURATION_BUCKETS: ReadonlySet<string> = new Set(['under_30s', '30s_2m', '2m_5m', 'over_5m']);
export const COUNT_BUCKETS: ReadonlySet<string> = new Set(['0', '1', '2_5', '6_20', '21_plus']);
export const SMALL_COUNT_BUCKETS: ReadonlySet<string> = new Set(['0', '1', '2_3', '4_plus']);
export const ATTEMPT_COUNT_BUCKETS: ReadonlySet<string> = new Set(['1', '2', '3_plus']);
export const SELLERS_TRIED_BUCKETS: ReadonlySet<string> = new Set(['0', '1', '2', '3_plus']);
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
