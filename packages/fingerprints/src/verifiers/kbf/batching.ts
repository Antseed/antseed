import type { KbfProbe } from '../../types.js';

/** A batch of probes asked in one request, with each probe's index in the list it was cut from. */
export interface IndexedKbfProbeBatch {
  probes: KbfProbe[];
  indexes: number[];
}

/**
 * Cuts probes into single-domain batches: domains in the order they first appear, each domain's
 * probes in their given order (or as `order` returns them), at most `batchSize` per batch. A
 * reference's consensus and self-test error are measured on single-domain batches, as in the KBF
 * reference code, and answers shift when the questions around them do, so every audit and
 * calibration batches this way (`KBF_PROBES_PER_REQUEST` per request).
 */
export function kbfDomainBatches(
  probes: readonly KbfProbe[],
  batchSize: number,
  order: <T>(values: readonly T[]) => T[] = (values) => [...values],
): IndexedKbfProbeBatch[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('KBF batch size must be a positive integer');
  const byDomain = new Map<string, Array<{ probe: KbfProbe; index: number }>>();
  for (const [index, probe] of probes.entries()) {
    const entries = byDomain.get(probe.domain) ?? [];
    entries.push({ probe, index });
    byDomain.set(probe.domain, entries);
  }
  const batches: IndexedKbfProbeBatch[] = [];
  for (const entries of byDomain.values()) {
    const ordered = order(entries);
    for (let offset = 0; offset < ordered.length; offset += batchSize) {
      const batch = ordered.slice(offset, offset + batchSize);
      batches.push({
        probes: batch.map(({ probe }) => probe),
        indexes: batch.map(({ index }) => index),
      });
    }
  }
  return batches;
}
