import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPrivacyToKeys, publishUnderCurrentPrivacy } from './privacy-keys.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

test('Private reaches every app key before the desktop key shows it', async () => {
  const order: string[] = [];
  await applyPrivacyToKeys('private', 'desktop', () => ['codex', 'desktop', 'goose'], async (id) => { order.push(id); }, () => order.push('commit'));
  assert.deepEqual(order, ['codex', 'goose', 'desktop', 'commit']);
});

test('leaving Private changes the desktop key first, so a failed app key stays private', async () => {
  const order: string[] = [];
  await assert.rejects(applyPrivacyToKeys('anonymous', 'desktop', () => ['codex', 'goose'], async (id) => {
    if (id === 'codex') throw new Error('policy write failed');
    order.push(id);
  }, () => order.push('commit')), /policy write failed/);
  assert.deepEqual(order, ['desktop']);
});

test('a failed app key leaves the desktop key, and the mode shown, unchanged', async () => {
  const order: string[] = [];
  await assert.rejects(applyPrivacyToKeys('private', 'desktop', () => ['codex'], async (id) => {
    if (id === 'codex') throw new Error('policy write failed');
    order.push(id);
  }, () => order.push('commit')), /policy write failed/);
  assert.deepEqual(order, []);
});

/** A gateway with saved keys and the saved mode, for overlapping a new key with a switch. */
function fakeGateway() {
  let mode: 'anonymous' | 'private' = 'anonymous';
  const saved: string[] = [];
  const policy = new Map<string, 'anonymous' | 'private'>();
  return {
    saved, policy,
    mode: () => mode,
    switchTo: (next: 'anonymous' | 'private', between: () => Promise<void> = async () => undefined) => applyPrivacyToKeys(
      next, 'desktop', () => ['desktop', ...saved],
      async (id) => { await between(); policy.set(id, next); },
      () => { mode = next; },
    ),
    newKey: (id: string, created: Promise<void>) => publishUnderCurrentPrivacy(
      async (assumed) => { await created; policy.set(id, assumed); saved.push(id); return id; },
      () => mode,
      async (key, next) => { policy.set(key, next); },
      async () => undefined,
    ),
  };
}

test('an app key created while Private turns on, saved after the switch listed keys, still ends up Private', async () => {
  const gateway = fakeGateway();
  const created = deferred();
  const key = gateway.newKey('codex', created.promise);
  await gateway.switchTo('private');
  created.resolve();
  await key;
  assert.equal(gateway.policy.get('codex'), 'private');
});

test('an app key saved while the switch is still writing is caught up once the mode is saved', async () => {
  const gateway = fakeGateway();
  const created = deferred();
  const key = gateway.newKey('codex', created.promise);
  const switching = gateway.switchTo('private', async () => {
    // The key lands between the switch's listing and its save.
    created.resolve();
    await key;
  });
  await switching;
  assert.equal(gateway.policy.get('codex'), 'private');
});

test('a key that can\'t be brought to the new mode is discarded, not left unrestricted', async () => {
  let mode: 'anonymous' | 'private' = 'anonymous';
  const discarded: string[] = [];
  await assert.rejects(publishUnderCurrentPrivacy(
    async () => { mode = 'private'; return 'codex'; },
    () => mode,
    async () => { throw new Error('policy write failed'); },
    async (key) => { discarded.push(key); },
  ), /policy write failed/);
  assert.deepEqual(discarded, ['codex']);
});
