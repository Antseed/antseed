import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { gatewayKeyScope } from './key-scope.js';
import { cachedRead, disposeChainReads, readKeys } from '../payments/read-cache.js';

// gcTime timers would keep the test process alive.
after(() => disposeChainReads());

test('two keys on the same gateway get different balance scopes, and the key never appears in it', () => {
  const a = gatewayKeyScope('remote', 'https://gw.example', 'antseed_key_a');
  const b = gatewayKeyScope('remote', 'https://gw.example', 'antseed_key_b');
  assert.notEqual(a, b);
  assert.equal(a, gatewayKeyScope('remote', 'https://gw.example', 'antseed_key_a'));
  assert.ok(!a.includes('antseed_key_a'));
});

test('a balance read for key B never returns or joins key A\'s read on the same gateway', async () => {
  const keyA = readKeys.credits(gatewayKeyScope('remote', 'https://gw.example', 'antseed_key_a'));
  const keyB = readKeys.credits(gatewayKeyScope('remote', 'https://gw.example', 'antseed_key_b'));
  let releaseA: (value: string) => void = () => {};
  const readA = cachedRead(keyA, 4_000, () => new Promise<string>((resolve) => { releaseA = resolve; }));
  // Key B is read while A's read is still in flight, then again once A answered.
  const readB = cachedRead(keyB, 4_000, async () => 'balance of B');
  releaseA('balance of A');
  assert.equal(await readA, 'balance of A');
  assert.equal(await readB, 'balance of B');
  assert.equal(await cachedRead(keyB, 4_000, async () => 'balance of B, read again'), 'balance of B');
});
