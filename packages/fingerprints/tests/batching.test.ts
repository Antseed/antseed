import { describe, expect, it } from 'vitest';
import { KBF_PROBES_PER_REQUEST, kbfDomainBatches } from '../src/index.js';
import type { KbfProbe } from '../src/types.js';

const probe = (index: number, domain: string): KbfProbe => ({
  id: `q${index}`, name: `q${index}`, domain, template: `q${index} is ___.`, consensus: 1,
  range: [0, 10], tolerance: { mode: 'absolute', value: 0 },
});

describe('kbfDomainBatches', () => {
  it('is pinned: domains in first-seen order, the given order inside, at most the batch size each', () => {
    // The same 30 questions and batches are pinned in the CLI's kbf-batching tests and in model-verifier.
    const domains = ['math', 'law', 'math', 'bio'];
    const probes = Array.from({ length: 30 }, (_, index) => probe(index, domains[index % 4]!));
    const batches = kbfDomainBatches(probes, KBF_PROBES_PER_REQUEST);
    expect(batches.map((batch) => batch.indexes)).toEqual([
      [0, 2, 4, 6, 8, 10, 12, 14, 16, 18],
      [20, 22, 24, 26, 28],
      [1, 5, 9, 13, 17, 21, 25, 29],
      [3, 7, 11, 15, 19, 23, 27],
    ]);
    expect(batches.every((batch) => batch.probes.every((entry, position) => entry === probes[batch.indexes[position]!]))).toBe(true);
  });

  it('orders each domain with `order` before cutting it, and refuses a batch size that is not a positive integer', () => {
    const probes = [probe(0, 'a'), probe(1, 'a'), probe(2, 'a')];
    expect(kbfDomainBatches(probes, 2, (values) => [...values].reverse()).map((batch) => batch.indexes)).toEqual([[2, 1], [0]]);
    expect(() => kbfDomainBatches(probes, 0)).toThrow(/positive integer/);
  });
});
