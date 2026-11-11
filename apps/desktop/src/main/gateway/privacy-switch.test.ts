import test from 'node:test';
import assert from 'node:assert/strict';
import type { GatewayPrivacy, GatewayPrivacyMode } from '../../shared/gateway-types.js';
import { readPrivacy, switchPrivacy, type PrivacySwitchDeps } from './privacy-switch.js';

function harness(options: { gateway?: 'local' | 'remote'; saved?: GatewayPrivacyMode } = {}) {
  const calls: string[] = [];
  let saved: GatewayPrivacyMode = options.saved ?? 'anonymous';
  const privacy = (mode: GatewayPrivacyMode): GatewayPrivacy => ({ mode, editable: true, requiredAbove: false });
  const deps: PrivacySwitchDeps = {
    setPrivacy: async (mode) => {
      calls.push(`set:${mode}`);
      saved = mode;
      return privacy(mode);
    },
    getPrivacy: async () => {
      calls.push('get');
      return privacy(saved);
    },
    savedPrivacy: () => saved,
    gatewayMode: () => options.gateway ?? 'local',
    clearCaches: () => { calls.push('clear-caches'); },
    refreshApps: () => { calls.push('refresh-apps'); },
  };
  return { deps, calls, setSaved: (mode: GatewayPrivacyMode) => { saved = mode; } };
}

test('a privacy switch drops the cached model list, then rewrites every connected app', async () => {
  const { deps, calls } = harness();
  const result = await switchPrivacy('private', deps);
  assert.equal(result.mode, 'private');
  assert.deepEqual(calls, ['set:private', 'clear-caches', 'refresh-apps']);
});

test('a switch that failed partway still rewrites the apps, since some keys may have changed', async () => {
  const { deps, calls } = harness();
  deps.setPrivacy = async () => { throw new Error('database is locked'); };
  await assert.rejects(switchPrivacy('private', deps), /database is locked/);
  assert.deepEqual(calls, ['clear-caches', 'refresh-apps']);
});

test('a remote gateway refuses the switch and no app is touched', async () => {
  const { deps, calls } = harness({ gateway: 'remote' });
  deps.setPrivacy = async () => { throw new Error('A remote gateway\'s routing policy is set in its console'); };
  await assert.rejects(switchPrivacy('private', deps), /remote gateway/);
  assert.deepEqual(calls, []);
});

test('a read that moved every key to a mode set in the console rewrites the apps; a plain read does not', async () => {
  const plain = harness();
  await readPrivacy(plain.deps);
  assert.deepEqual(plain.calls, ['get']);

  const changed = harness();
  changed.deps.getPrivacy = async () => {
    changed.calls.push('get');
    changed.setSaved('private');
    return { mode: 'private', editable: true, requiredAbove: false };
  };
  assert.equal((await readPrivacy(changed.deps)).mode, 'private');
  assert.deepEqual(changed.calls, ['get', 'clear-caches', 'refresh-apps']);
});
