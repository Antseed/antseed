import test from 'node:test';
import assert from 'node:assert/strict';
import type { GatewayPrivacy, GatewayPrivacyMode } from '../../shared/gateway-types.js';
import { readPrivacy, privacyInTurn, switchPrivacy, type PrivacySwitchDeps } from './privacy-switch.js';
import { createSerialQueue } from '../serial-queue.js';

/**
 * Like the gateway service: `keyMode` is the desktop key's policy, which the
 * console can change; a read brings the saved mode in line with it, and reads
 * and switches take turns on one queue.
 */
function harness(options: { gateway?: 'local' | 'remote' } = {}) {
  const calls: string[] = [];
  const queue = createSerialQueue();
  let saved: GatewayPrivacyMode = 'anonymous';
  let keyMode: GatewayPrivacyMode = 'anonymous';
  const privacy = (mode: GatewayPrivacyMode): GatewayPrivacy => ({ mode, editable: true, requiredAbove: false });
  let held: Promise<void> = Promise.resolve();
  const deps: PrivacySwitchDeps = {
    setPrivacy: (mode) => queue.run(async () => {
      await held;
      calls.push(`set:${mode}`);
      const before = saved;
      keyMode = mode;
      saved = mode;
      return { privacy: privacy(mode), changed: saved !== before };
    }),
    getPrivacy: () => privacyInTurn(queue, async () => {
      calls.push('get');
      saved = keyMode;
      return privacy(keyMode);
    }, () => saved),
    gatewayMode: () => options.gateway ?? 'local',
    clearCaches: () => { calls.push('clear-caches'); },
    refreshApps: () => { calls.push('refresh-apps'); },
  };
  return {
    deps,
    calls,
    setInConsole: (mode: GatewayPrivacyMode) => { keyMode = mode; },
    /** Holds the next switch until the returned function runs. */
    holdSwitch: () => {
      let release = () => {};
      held = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
  };
}

test('a privacy switch drops the cached model list, then rewrites every connected app', async () => {
  const { deps, calls } = harness();
  const result = await switchPrivacy('private', deps);
  assert.equal(result.mode, 'private');
  assert.deepEqual(calls, ['set:private', 'clear-caches', 'refresh-apps']);
});

test('choosing the mode already in effect leaves the caches and apps alone', async () => {
  const { deps, calls } = harness();
  const result = await switchPrivacy('anonymous', deps);
  assert.equal(result.mode, 'anonymous');
  assert.deepEqual(calls, ['set:anonymous']);
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
  changed.setInConsole('private');
  assert.equal((await readPrivacy(changed.deps)).mode, 'private');
  assert.deepEqual(changed.calls, ['get', 'clear-caches', 'refresh-apps']);
});

test('a read queued behind a switch does not rewrite the apps a second time', async () => {
  const { deps, calls, holdSwitch } = harness();
  const release = holdSwitch();
  const switching = switchPrivacy('private', deps);
  const reading = readPrivacy(deps);
  release();
  assert.equal((await reading).mode, 'private');
  await switching;
  // The read ran after the switch, which already rewrote the apps.
  assert.equal(calls.indexOf('get') > calls.indexOf('set:private'), true);
  assert.deepEqual(calls.filter((call) => call === 'refresh-apps'), ['refresh-apps']);
});
