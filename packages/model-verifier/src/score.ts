/**
 * Per-agent verification score, formula version 1. Mirrors
 * AntseedVerification.computeScoreBps so anyone can recompute an on-chain score
 * from the published per-service results.
 */

export const SCORE_FORMULA_VERSION = 1
export const SERVICE_MODEL_MATCH = 1
export const SERVICE_PRICE_MATCH = 2
export const SERVICE_UNDETERMINED = 4

const BPS = 10_000n
const LOG2_MICRO = [
  0, 1000000, 1584963, 2000000, 2321928, 2584963, 2807355, 3000000, 3169925, 3321928, 3459432, 3584963,
  3700440, 3807355, 3906891, 4000000, 4087463, 4169925, 4247928, 4321928, 4392317, 4459432, 4523562,
  4584963, 4643856, 4700440, 4754888, 4807355, 4857981, 4906891, 4954196, 5000000, 5044394,
] as const

export interface ServiceScoreInput {
  modelHash: string
  flags: number
}

export function servicePassed(flags: number): boolean {
  const passedMask = SERVICE_MODEL_MATCH | SERVICE_PRICE_MATCH
  return (flags & passedMask) === passedMask && (flags & SERVICE_UNDETERMINED) === 0
}

export function computeScoreBps(results: readonly ServiceScoreInput[], maxBreadth = 8): number {
  if (!Number.isInteger(maxBreadth) || maxBreadth < 1 || maxBreadth > 32) {
    throw new Error('maxBreadth must be an integer from 1 through 32')
  }
  if (results.length === 0) return 0
  const passed = results.filter((result) => servicePassed(result.flags))
  if (passed.length === 0) return 0
  const distinct = new Set(passed.map((result) => result.modelHash.toLowerCase())).size
  const breadth = Math.min(distinct, maxBreadth)
  const breadthBps = (BigInt(LOG2_MICRO[breadth]!) * BPS) / BigInt(LOG2_MICRO[maxBreadth]!)
  const integrityBps = (BigInt(passed.length) * BPS) / BigInt(results.length)
  return Number((breadthBps * integrityBps ** 4n) / BPS ** 4n)
}
