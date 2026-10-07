import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveInstancePorts, resolveInstanceSlot } from './dev-instance-config.mjs';

test('resolveInstanceSlot returns a stable non-default slot for every instance name', () => {
  for (const instanceName of ['status', 'codex', '0', '-10000', '999999']) {
    const slot = resolveInstanceSlot(instanceName);
    assert.equal(resolveInstanceSlot(instanceName), slot);
    assert.ok(slot >= 1 && slot <= 999);
  }
});

test('resolveInstancePorts never returns the single-instance defaults or invalid ports', () => {
  const ports = resolveInstancePorts('0');

  assert.notEqual(ports.renderer, 5174);
  assert.notEqual(ports.payments, 3118);
  assert.notEqual(ports.systemProxy, 8378);
  for (const port of Object.values(ports)) {
    assert.ok(port > 0 && port <= 65_535);
  }
});

test('resolveInstanceSlot rejects empty instance names', () => {
  assert.throws(() => resolveInstanceSlot('  '), /must not be empty/);
});
