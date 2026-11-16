import { randomInt } from 'node:crypto'
import type { KbfProbe } from '@antseed/fingerprints'

export interface IndexedKbfProbeBatch {
  probes: KbfProbe[]
  indexes: number[]
}

export function createDomainHomogeneousKbfBatches(
  probes: readonly KbfProbe[],
  batchSize: number,
  shuffle: <T>(values: readonly T[]) => T[] = cryptoShuffle,
): IndexedKbfProbeBatch[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('KBF batch size must be a positive integer')
  const byDomain = new Map<string, Array<{ probe: KbfProbe; index: number }>>()
  for (const [index, probe] of probes.entries()) {
    const entries = byDomain.get(probe.domain) ?? []
    entries.push({ probe, index })
    byDomain.set(probe.domain, entries)
  }
  const batches: IndexedKbfProbeBatch[] = []
  for (const entries of byDomain.values()) {
    const ordered = shuffle(entries)
    for (let offset = 0; offset < ordered.length; offset += batchSize) {
      const batch = ordered.slice(offset, offset + batchSize)
      batches.push({
        probes: batch.map(({ probe }) => probe),
        indexes: batch.map(({ index }) => index),
      })
    }
  }
  return batches
}

function cryptoShuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1)
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!]
  }
  return shuffled
}
