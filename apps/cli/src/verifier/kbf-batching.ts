import { randomInt } from 'node:crypto'
import { KBF_PROBES_PER_REQUEST, kbfDomainBatches, type IndexedKbfProbeBatch, type KbfProbe } from '@antseed/fingerprints'

export type { IndexedKbfProbeBatch }

/** Single-domain batches (`kbfDomainBatches`), each domain shuffled first unless `shuffle` says otherwise. */
export function createDomainHomogeneousKbfBatches(
  probes: readonly KbfProbe[],
  batchSize: number,
  shuffle: <T>(values: readonly T[]) => T[] = cryptoShuffle,
): IndexedKbfProbeBatch[] {
  return kbfDomainBatches(probes, batchSize, shuffle)
}

/**
 * The batches of a question set exactly as sellers get them: set order, one domain per request. The
 * reference is calibrated on these same batches, so its limit is measured on what is audited.
 */
export function kbfAuditBatches(probes: readonly KbfProbe[]): IndexedKbfProbeBatch[] {
  return kbfDomainBatches(probes, KBF_PROBES_PER_REQUEST)
}

function cryptoShuffle<T>(values: readonly T[]): T[] {
  const shuffled = [...values]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1)
    ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!]
  }
  return shuffled
}
