import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isAttachOnly,
  preserveSandboxTrustFloor,
  readAttachOnlyIdentityHex,
  resolveBuyerStateDir,
} from './attach-only.js';

const ATTACH = { ANTSEED_DESKTOP_ATTACH_ONLY: '1' };

test('isAttachOnly only accepts the explicit flag', () => {
  assert.equal(isAttachOnly(ATTACH), true);
  assert.equal(isAttachOnly({}), false);
  assert.equal(isAttachOnly({ ANTSEED_DESKTOP_ATTACH_ONLY: 'true' }), false);
});

test('buyer state follows the connect data dir and defaults to ~/.antseed', () => {
  assert.equal(resolveBuyerStateDir({}, '/home/u'), path.join('/home/u', '.antseed'));
  assert.equal(resolveBuyerStateDir({ ANTSEED_DESKTOP_CONNECT_DATA_DIR: '  ' }, '/home/u'), path.join('/home/u', '.antseed'));
  assert.equal(resolveBuyerStateDir({ ANTSEED_DESKTOP_CONNECT_DATA_DIR: '/tmp/sb/buyer' }, '/home/u'), '/tmp/sb/buyer');
  assert.equal(resolveBuyerStateDir({ ANTSEED_DESKTOP_CONNECT_DATA_DIR: '~/sb/buyer' }, '/home/u'), path.join('/home/u', 'sb/buyer'));
});

test('trust floor is forced to 0 only in attach-only mode and keeps other preferences', () => {
  const config = { buyer: { routingPreferences: { minTrustScore: 50, preferCheap: true }, other: 1 }, seller: { x: 1 } };
  assert.equal(preserveSandboxTrustFloor(config, {}), config);
  assert.deepEqual(preserveSandboxTrustFloor(config, ATTACH), {
    buyer: { routingPreferences: { minTrustScore: 0, preferCheap: true }, other: 1 },
    seller: { x: 1 },
  });
  assert.equal(config.buyer.routingPreferences.minTrustScore, 50);
});

test('trust floor leaves configs without routing preferences untouched', () => {
  for (const config of [{}, { buyer: null }, { buyer: [] }, { buyer: {} }, { buyer: { routingPreferences: [] } }]) {
    assert.equal(preserveSandboxTrustFloor(config as Record<string, unknown>, ATTACH), config);
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
