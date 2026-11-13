import assert from 'node:assert/strict';
import test from 'node:test';
import type { Identity } from '@antseed/node';
import { ATTACH_ONLY_IMPORT_REFUSED, identityImportRefusal, importIdentityKey, type IdentityImportDeps } from './identity-import.js';

const KEY = `0x${'ab'.repeat(32)}`;

function recordingDeps(env: NodeJS.ProcessEnv) {
  const calls: string[] = [];
  const deps: IdentityImportDeps = {
    env,
    safeStorageAvailable: () => { calls.push('safeStorageAvailable'); return true; },
    toIdentity: (hex) => { calls.push(`toIdentity:${hex}`); return { wallet: { address: '0xabc' } } as unknown as Identity; },
    backup: async () => { calls.push('backup'); return '/home/u/.antseed/identity.enc.bak-1'; },
    save: async (hex) => { calls.push(`save:${hex}`); },
  };
  return { calls, deps };
}

test('an attach-only desktop refuses identity import before touching secure storage or any file', async () => {
  const { calls, deps } = recordingDeps({ ANTSEED_DESKTOP_ATTACH_ONLY: '1' });
  const result = await importIdentityKey(KEY, deps);
  assert.deepEqual(result, { ok: false, error: ATTACH_ONLY_IMPORT_REFUSED });
  assert.deepEqual(calls, [], 'no safeStorage check, no backup, no write');
  assert.deepEqual(identityImportRefusal({ ANTSEED_DESKTOP_ATTACH_ONLY: '1' }), { ok: false, error: ATTACH_ONLY_IMPORT_REFUSED });
});

test('a normal desktop and the isolated profile still import as before', async () => {
  for (const env of [{}, { ANTSEED_DESKTOP_ISOLATED_PROFILE: '1' }]) {
    const { calls, deps } = recordingDeps(env);
    const result = await importIdentityKey(KEY, deps);
    assert.equal(result.ok, true);
    assert.equal(result.address, '0xabc');
    assert.equal(result.backupPath, '/home/u/.antseed/identity.enc.bak-1');
    assert.deepEqual(calls, ['safeStorageAvailable', `toIdentity:${'ab'.repeat(32)}`, 'backup', `save:${'ab'.repeat(32)}`]);
    assert.equal(identityImportRefusal(env), null);
  }
  const { calls, deps } = recordingDeps({});
  assert.match((await importIdentityKey('nope', deps)).error ?? '', /expected 64 hex characters/);
  assert.deepEqual(calls, ['safeStorageAvailable'], 'an invalid key writes nothing');
});
