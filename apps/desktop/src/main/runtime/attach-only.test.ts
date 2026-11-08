import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isAttachOnly,
  isIsolatedProfile,
  machineWideChangesDisabled,
  preserveTestbenchRouting,
  readAttachOnlyIdentityHex,
  resolveBuyerStateDir,
  secretStoreSwitches,
  usesPlainTextSecretStore,
} from './attach-only.js';

const ATTACH = { ANTSEED_DESKTOP_ATTACH_ONLY: '1' };

test('isAttachOnly only accepts the explicit flag', () => {
  assert.equal(isAttachOnly(ATTACH), true);
  assert.equal(isAttachOnly({}), false);
  assert.equal(isAttachOnly({ ANTSEED_DESKTOP_ATTACH_ONLY: 'true' }), false);
});

test('isolated profiles and attach-only desktops both disable machine-wide changes', () => {
  const profile = { ANTSEED_DESKTOP_ISOLATED_PROFILE: '1' };
  assert.equal(isIsolatedProfile(profile), true);
  assert.equal(isIsolatedProfile({ ANTSEED_DESKTOP_ISOLATED_PROFILE: 'yes' }), false);
  assert.equal(isAttachOnly(profile), false);
  assert.equal(machineWideChangesDisabled(profile), true);
  assert.equal(machineWideChangesDisabled(ATTACH), true);
  assert.equal(machineWideChangesDisabled({}), false);
});

test('buyer state follows the connect data dir and defaults to ~/.antseed', () => {
  assert.equal(resolveBuyerStateDir({}, '/home/u'), path.join('/home/u', '.antseed'));
  assert.equal(resolveBuyerStateDir({ ANTSEED_DESKTOP_CONNECT_DATA_DIR: '  ' }, '/home/u'), path.join('/home/u', '.antseed'));
  assert.equal(resolveBuyerStateDir({ ANTSEED_DESKTOP_CONNECT_DATA_DIR: '/tmp/tb/buyer' }, '/home/u'), '/tmp/tb/buyer');
  assert.equal(resolveBuyerStateDir({ ANTSEED_DESKTOP_CONNECT_DATA_DIR: '~/tb/buyer' }, '/home/u'), path.join('/home/u', 'tb/buyer'));
});

test('attach-only chat data lives under the testbench buyer dir, never ~/.antseed', async () => {
  const env = { ANTSEED_DESKTOP_ATTACH_ONLY: '1', ANTSEED_DESKTOP_CONNECT_DATA_DIR: '/tmp/tb/buyer' };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const paths = await import(`../chat/paths.js?attach=${Date.now()}`);
    assert.equal(paths.ANTSEED_HOME_DIR, path.join('/tmp/tb/buyer', 'desktop'));
    assert.equal(paths.CHAT_DATA_DIR, path.join('/tmp/tb/buyer', 'desktop', 'chat'));
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('trust floor is forced to 0 only in attach-only mode and keeps other preferences', () => {
  const config = { buyer: { routingPreferences: { minTrustScore: 50, preferCheap: true }, other: 1 }, seller: { x: 1 } };
  assert.equal(preserveTestbenchRouting(config, {}, {}), config);
  assert.deepEqual(preserveTestbenchRouting(config, {}, ATTACH), {
    buyer: { routingPreferences: { minTrustScore: 0, preferCheap: true }, other: 1 },
    seller: { x: 1 },
  });
  assert.equal(config.buyer.routingPreferences.minTrustScore, 50);
});

test('trust floor leaves configs without routing preferences untouched', () => {
  for (const config of [{}, { buyer: null }, { buyer: [] }, { buyer: {} }, { buyer: { routingPreferences: [] } }]) {
    assert.equal(preserveTestbenchRouting(config as Record<string, unknown>, {}, ATTACH), config);
  }
});

test('attach-only identity reads a 64-hex key and rejects anything else', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'attach-only-'));
  try {
    const key = 'ab'.repeat(32);
    await writeFile(path.join(dir, 'identity.key'), `${key}\n`);
    assert.equal(await readAttachOnlyIdentityHex(dir), key);
    await writeFile(path.join(dir, 'identity.key'), 'abc');
    await assert.rejects(readAttachOnlyIdentityHex(dir), /unexpected identity format/);
    await writeFile(path.join(dir, 'identity.key'), 'zz'.repeat(32));
    await assert.rejects(readAttachOnlyIdentityHex(dir), /unexpected identity format/);
    await rm(path.join(dir, 'identity.key'));
    await assert.rejects(readAttachOnlyIdentityHex(dir), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('testbench desktops never use the real keychain or keyring', () => {
  const profile = { ANTSEED_DESKTOP_ISOLATED_PROFILE: '1' };
  assert.deepEqual(secretStoreSwitches({}, 'darwin'), []);
  assert.deepEqual(secretStoreSwitches({}, 'linux'), []);
  assert.deepEqual(secretStoreSwitches(ATTACH, 'darwin'), [['use-mock-keychain']]);
  assert.deepEqual(secretStoreSwitches(ATTACH, 'linux'), [['use-mock-keychain'], ['password-store', 'basic']]);
  assert.deepEqual(secretStoreSwitches(ATTACH, 'win32'), [['use-mock-keychain'], ['password-store', 'basic']]);
  assert.deepEqual(secretStoreSwitches(profile, 'darwin'), [['use-mock-keychain']]);
  assert.deepEqual(secretStoreSwitches(profile, 'linux'), [['use-mock-keychain'], ['password-store', 'basic']]);
});

test('only the isolated profile on Linux allows plain-text encryption for its basic store', () => {
  const profile = { ANTSEED_DESKTOP_ISOLATED_PROFILE: '1' };
  assert.equal(usesPlainTextSecretStore(profile, 'linux'), true);
  assert.equal(usesPlainTextSecretStore(profile, 'darwin'), false);
  assert.equal(usesPlainTextSecretStore(profile, 'win32'), false);
  assert.equal(usesPlainTextSecretStore(ATTACH, 'linux'), false);
  assert.equal(usesPlainTextSecretStore({}, 'linux'), false);
});

test('a routing sync keeps the testbench peer allowlist and blocklist', () => {
  const existing = { buyer: { routingPreferences: { allowedPeerIds: ['a', 'b'], blockedPeerIds: ['z'], preferLowLatency: true, minTrustScore: 0 } } };
  const synced = { buyer: { routingPreferences: { allowedPeerIds: [], blockedPeerIds: [], minTrustScore: 50, preferCheap: true } } };
  assert.deepEqual(preserveTestbenchRouting(synced, existing, ATTACH), {
    buyer: { routingPreferences: { allowedPeerIds: ['a', 'b'], blockedPeerIds: ['z'], minTrustScore: 0, preferCheap: true } },
  });
  assert.deepEqual(preserveTestbenchRouting(synced, { buyer: { routingPreferences: {} } }, ATTACH), {
    buyer: { routingPreferences: { allowedPeerIds: [], blockedPeerIds: [], minTrustScore: 0, preferCheap: true } },
  });
  assert.equal(preserveTestbenchRouting(synced, existing, {}), synced);
});
