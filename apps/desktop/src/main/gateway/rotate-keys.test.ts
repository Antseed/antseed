import assert from 'node:assert/strict';
import test from 'node:test';
import { rotateKeys } from './rotate-keys.js';

function store(keys: Record<string, { id: string | null }>, failing: string[] = []) {
  const revoked: string[] = [];
  return {
    keys,
    revoked,
    ops: {
      get: (scope: string) => keys[scope],
      revoke: async (id: string) => {
        if (failing.includes(id)) throw new Error('database is locked');
        revoked.push(id);
      },
      forget: (scope: string) => { delete keys[scope]; },
    },
  };
}

test('revokes each key and forgets it', async () => {
  const s = store({ desktop: { id: 'a' }, zed: { id: 'b' } });
  await rotateKeys(['desktop', 'zed'], s.ops);
  assert.deepEqual(s.revoked, ['a', 'b']);
  assert.deepEqual(s.keys, {});
});

test('a failed revoke keeps the key for another try, reports it and still replaces the rest', async () => {
  const s = store({ desktop: { id: 'a' }, zed: { id: 'b' } }, ['a']);
  await assert.rejects(rotateKeys(['desktop', 'zed'], s.ops), /desktop key: the old one still works.*database is locked/);
  assert.deepEqual(s.keys, { desktop: { id: 'a' } });
  assert.deepEqual(s.revoked, ['b']);
});

test('a key without a gateway id has nothing to revoke and is just forgotten', async () => {
  const s = store({ desktop: { id: null } });
  await rotateKeys(['desktop'], s.ops);
  assert.deepEqual(s.revoked, []);
  assert.deepEqual(s.keys, {});
});

test('a key the gateway no longer knows is forgotten, not reported forever', async () => {
  const s = store({ desktop: { id: 'a' } });
  s.ops.revoke = async () => { throw new Error('Unknown key "a". Run `antseed gateway key list`.'); };
  await rotateKeys(['desktop'], s.ops);
  assert.deepEqual(s.keys, {});
});
