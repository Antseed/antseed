/**
 * The verification points multiplier, exactly as `AntseedVerificationPointsPolicy.points`
 * computes it from a seller agent's live verdicts:
 * max(0, BPS + min(same × bonus, MAX_BONUS_BPS) − diff² × penalty), in basis points.
 */
export const VERIFICATION_POINTS_BPS = 10_000;
export const VERIFICATION_POINTS_MAX_BONUS_BPS = 5_000;

export interface VerificationPointsRates {
  bonusBps: bigint;
  penaltyBps: bigint;
}

export function verificationPointsMultiplierBps(sameCount: number, diffCount: number, rates: VerificationPointsRates): number {
  let bonus = BigInt(sameCount) * rates.bonusBps;
  if (bonus > BigInt(VERIFICATION_POINTS_MAX_BONUS_BPS)) bonus = BigInt(VERIFICATION_POINTS_MAX_BONUS_BPS);
  const penalty = BigInt(diffCount) * BigInt(diffCount) * rates.penaltyBps;
  const multiplier = BigInt(VERIFICATION_POINTS_BPS) + bonus - penalty;
  return Number(multiplier > 0n ? multiplier : 0n);
}
