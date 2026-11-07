import assert from 'node:assert/strict';
import test from 'node:test';
import { assertKeyMayBeRecreated, keyIsUsable, rotateKeys } from './rotate-keys.js';

function store(keys: Record<string, { id: string | null; secret: string }>) {
  return {
    keys,
    ops: {
      get: (scope: string) => keys[scope],
      rotate: async (id: string): Promise<string | null> => `new-${id}`,
      save: (scope: string, secret: string) => { keys[scope] = { ...keys[scope]!, secret }; },
      forget: (scope: string) => { delete keys[scope]; },
    },
  };
}

test('keeps the same key on the gateway with a new secret', async () => {
  const s = store({ desktop: { id: 'a', secret: 'old-a' }, zed: { id: 'b', secret: 'old-b' } });
  await rotateKeys(['desktop', 'zed'], s.ops);
  assert.deepEqual(s.keys, { desktop: { id: 'a', secret: 'new-a' }, zed: { id: 'b', secret: 'new-b' } });
});

test('a failure keeps the key for another try, reports it and still replaces the rest', async () => {
  const s = store({ desktop: { id: 'a', secret: 'old-a' }, zed: { id: 'b', secret: 'old-b' } });
  s.ops.rotate = async (id) => {
    if (id === 'a') throw new Error('database is locked');
    return `new-${id}`;
  };
  await assert.rejects(rotateKeys(['desktop', 'zed'], s.ops), /desktop key could not be changed and still works.*database is locked/);
  assert.deepEqual(s.keys, { desktop: { id: 'a', secret: 'old-a' }, zed: { id: 'b', secret: 'new-b' } });
});

test('a key that cannot come back, has no id, or is unknown to the gateway is forgotten', async () => {
  const s = store({ revoked: { id: 'r', secret: 'x' }, bare: { id: null, secret: 'y' }, gone: { id: 'g', secret: 'z' } });
  s.ops.rotate = async (id) => {
    if (id === 'g') throw new Error('Command failed (exit 1): Unknown key "g". Run `antseed gateway key list`.');
    return null;
  };
  await rotateKeys(['revoked', 'bare', 'gone'], s.ops);
  assert.deepEqual(s.keys, {});
});

test('keyIsUsable: active and not expired', () => {
  assert.equal(keyIsUsable({ status: 'active', expiresAt: null }), true);
  assert.equal(keyIsUsable({ status: 'active', expiresAt: 2_000 }, 1_000), true);
  assert.equal(keyIsUsable({ status: 'active', expiresAt: 1_000 }, 1_000), false);
  assert.equal(keyIsUsable({ status: 'revoked', expiresAt: null }), false);
});

test('a rejected key the gateway has a record of is not quietly recreated', async () => {
  await assert.rejects(
    assertKeyMayBeRecreated({ id: 'a', label: 'Desktop' }, async () => ({ status: 'revoked' })),
    /"Desktop" key was revoked, expired or replaced/,
  );
  await assert.rejects(
    assertKeyMayBeRecreated({ id: 'a', label: 'Desktop' }, async () => ({ status: 'active' })),
    /Replace keys in Settings/,
  );
});

test('a rejected key the gateway forgot may be recreated', async () => {
  await assertKeyMayBeRecreated({ id: 'a', label: 'Desktop' }, async () => {
    throw new Error('Command failed (exit 1): Unknown key "a".');
  });
  await assertKeyMayBeRecreated({ id: null, label: 'Desktop' }, async () => ({ status: 'active' }));
});

test('failing to read the record stops rather than creating a key', async () => {
  await assert.rejects(
    assertKeyMayBeRecreated({ id: 'a', label: 'Desktop' }, async () => { throw new Error('database is locked'); }),
    /database is locked/,
  );
});
