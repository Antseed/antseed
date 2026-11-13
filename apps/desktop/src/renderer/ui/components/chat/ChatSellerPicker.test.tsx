import assert from 'node:assert/strict';
import { test } from 'vitest';
import { sellerSaving } from './ChatSellerPicker';

test('a seller shows its saving against the reference price, only when both input and output are cheaper', () => {
  const reference = { inputUsdPerMillion: 0.4, outputUsdPerMillion: 3.4 };
  assert.equal(sellerSaving({ inputUsdPerMillion: 0.02, outputUsdPerMillion: 0.37 }, reference), '−95% / −89%');
  assert.equal(sellerSaving({ inputUsdPerMillion: 0.2, outputUsdPerMillion: 1.7 }, reference), '−50%');
  // One side at or above the reference, or no reference: nothing.
  assert.equal(sellerSaving({ inputUsdPerMillion: 0.5, outputUsdPerMillion: 0.37 }, reference), null);
  assert.equal(sellerSaving({ inputUsdPerMillion: 0.02, outputUsdPerMillion: 0.37 }, undefined), null);
});
