import { createHash } from 'node:crypto'

/**
 * Deterministic draws from an epoch seed. Every participant derives the same values from the
 * same (seed, label), so nobody chooses which questions a seller gets or who collects them.
 * Draw `i` of a stream is sha256(seed | label | i) read as a uint256.
 */
export class SeededStream {
  private counter = 0n

  constructor(
    private readonly seed: string,
    private readonly label: string,
  ) {}

  next(): bigint {
    const digest = createHash('sha256')
      .update(`antseed-kbf-seed-v1|${this.seed.toLowerCase()}|${this.label}|${this.counter}`)
      .digest('hex')
    this.counter += 1n
    return BigInt(`0x${digest}`)
  }

  /** Uniform integer in [0, max) by rejection sampling, so there is no modulo bias. */
  below(max: number): number {
    if (!Number.isInteger(max) || max <= 0) throw new Error(`invalid draw bound ${max}`)
    const bound = BigInt(max)
    const limit = (1n << 256n) - ((1n << 256n) % bound)
    for (;;) {
      const value = this.next()
      if (value < limit) return Number(value % bound)
    }
  }
}

/** Fisher–Yates shuffle driven by the seed; the input order must itself be canonical. */
export function seededShuffle<T>(items: readonly T[], seed: string, label: string): T[] {
  const stream = new SeededStream(seed, label)
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = stream.below(i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** Ranks addresses by sha256(seed | label | address); ties are impossible in practice. */
export function seededRanking(addresses: readonly string[], seed: string, label: string): string[] {
  const score = (address: string) =>
    createHash('sha256').update(`antseed-kbf-rank-v1|${seed.toLowerCase()}|${label}|${address.toLowerCase()}`).digest('hex')
  return [...addresses]
    .map((address) => ({ address: address.toLowerCase(), score: score(address) }))
    .sort((left, right) => (left.score < right.score ? -1 : left.score > right.score ? 1 : 0))
    .map((entry) => entry.address)
}
