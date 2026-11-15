import assert from 'node:assert/strict';
import { test } from 'vitest';
import { sellerSaving } from './ChatSellerPicker';

test('a seller shows its saving against the retail price as the old VPN did: input and output together', () => {
  const reference = { inputUsdPerMillion: 0.4, outputUsdPerMillion: 3.4 };
  // (0.02 + 0.37) against (0.4 + 3.4): 90% cheaper.
  assert.equal(sellerSaving({ inputUsdPerMillion: 0.02, outputUsdPerMillion: 0.37 }, reference), 'save 90%');
  // A pricier input still saves overall when output is much cheaper.
  assert.equal(sellerSaving({ inputUsdPerMillion: 0.5, outputUsdPerMillion: 0.37 }, reference), 'save 77%');
  // At or above retail, or with no reference: nothing.
  assert.equal(sellerSaving({ inputUsdPerMillion: 0.04, outputUsdPerMillion: 0.49 }, { inputUsdPerMillion: 0.0434, outputUsdPerMillion: 0.3 }), null);
  assert.equal(sellerSaving({ inputUsdPerMillion: 0.02, outputUsdPerMillion: 0.37 }, undefined), null);
});
