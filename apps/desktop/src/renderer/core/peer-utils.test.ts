import assert from 'node:assert/strict';
import { test } from 'vitest';

import { preferredPeerDisplayName } from './peer-utils.js';

test('explicit peer display names take precedence over generic labels', () => {
  assert.equal(
    preferredPeerDisplayName('Cobalt Relay', 'Other (9e8f9aae)'),
    'Cobalt Relay',
  );
});

test('peer labels remain the fallback when no display name is available', () => {
  assert.equal(preferredPeerDisplayName(null, 'CatGPT (b629449e)'), 'CatGPT');
});
