import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { attachOnlyEnv, desktopEnv } from '../lib/desktop.mjs';
import { assertTestbenchHome, BUYER_KEY_ENV, isolatedEnv, resolveBuyerKey, toolchainEnv, writeBuyerKey } from '../lib/env.mjs';
import { profileDesktopEnv, profilePaths, resolveMainnetWallet, walletAddress } from '../lib/mainnet.mjs';

const KEY = 'ab'.repeat(32);
const REAL_HOME = userInfo().homedir;
const manifest = {
  dir: '/tb/wt', home: '/tb/wt/home', buyerDir: '/tb/wt/buyer', buyerConfig: '/tb/wt/buyer/config.json',
  proxyUrl: 'http://127.0.0.1:40001', rpcUrl: 'http://127.0.0.1:40002',
};
const userEnv = { PATH: '/bin', HOME: REAL_HOME, ANTSEED_IDENTITY_HEX: 'cd'.repeat(32), [BUYER_KEY_ENV]: KEY, ANTSEED_DATA_DIR: join(REAL_HOME, '.antseed') };

describe('testbench buyer key', () => {
  it('is unset by default, so the testbench keeps its own generated key', () => {
    assert.equal(resolveBuyerKey({ env: {}, fileValues: {} }), null);
    assert.equal(resolveBuyerKey({ env: { [BUYER_KEY_ENV]: '  ' }, fileValues: {} }), null);
  });

  it('reads the shell first, then .env.local, and normalizes the hex', () => {
    assert.deepEqual(resolveBuyerKey({ env: {}, fileValues: { [BUYER_KEY_ENV]: `0x${KEY.toUpperCase()}` }, envFile: '/wt/.env.local' }), { hex: KEY, source: '/wt/.env.local' });
    assert.deepEqual(resolveBuyerKey({ env: { [BUYER_KEY_ENV]: 'cd'.repeat(32) }, fileValues: { [BUYER_KEY_ENV]: KEY } }), { hex: 'cd'.repeat(32), source: 'shell' });
  });

  it('rejects anything that is not a 64-hex private key', () => {
    assert.throws(() => resolveBuyerKey({ env: { [BUYER_KEY_ENV]: 'abc' } }), /64 hex characters/);
    assert.throws(() => resolveBuyerKey({ env: { [BUYER_KEY_ENV]: 'zz'.repeat(32) } }), /64 hex characters/);
    assert.throws(() => resolveMainnetWallet({ env: { ANTSEED_TESTBENCH_MAINNET_IDENTITY_HEX: 'abc' } }), /64 hex characters/);
  });

  it('becomes the testbench buyer identity, owner-only, replacing the previous testbench key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-buyer-'));
    try {
      await writeFile(join(dir, 'identity.key'), `${'11'.repeat(32)}\n`, { mode: 0o644 });
      await writeBuyerKey(dir, KEY);
      assert.equal((await readFile(join(dir, 'identity.key'), 'utf8')).trim(), KEY);
      assert.equal((await stat(join(dir, 'identity.key'))).mode & 0o777, 0o600);
      const sdk = await import('../../../packages/node/dist/index.js').catch(() => null);
      if (sdk) {
        delete process.env.ANTSEED_IDENTITY_HEX;
        const identity = await sdk.loadOrCreateIdentity(dir);
        assert.equal(identity.wallet.address, walletAddress(KEY));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('testbench HOME', () => {
  it('refuses the real home and anything inside the real ~/.antseed', () => {
    assert.throws(() => assertTestbenchHome(REAL_HOME), /never be your real home/);
    assert.throws(() => assertTestbenchHome(join(REAL_HOME, '.antseed')), /never be your real home/);
    assert.throws(() => assertTestbenchHome(join(REAL_HOME, '.antseed', 'x')), /never be your real home/);
    assert.throws(() => isolatedEnv(userEnv, REAL_HOME), /never be your real home/);
    assert.equal(assertTestbenchHome(join(REAL_HOME, '.antseed-testbench', 'wt', 'home')), join(REAL_HOME, '.antseed-testbench', 'wt', 'home'));
    assert.equal(assertTestbenchHome('/home/a', '/home/a2'), '/home/a');
  });

  it('attach-only desktops run on the testbench home with no inherited keys', () => {
    for (const env of [
      attachOnlyEnv({ manifest, baseEnv: userEnv }),
      desktopEnv({ manifest, instance: 'x', ports: { payments: 1, systemProxy: 2 }, baseEnv: userEnv }),
    ]) {
      assert.equal(env.HOME, manifest.home);
      assert.equal(env.ANTSEED_DESKTOP_ATTACH_ONLY, '1');
      assert.equal(env.ANTSEED_DESKTOP_CONNECT_DATA_DIR, manifest.buyerDir);
      for (const key of ['ANTSEED_IDENTITY_HEX', BUYER_KEY_ENV, 'ANTSEED_DATA_DIR']) assert.equal(env[key], undefined, key);
    }
  });

  it('mainnet profile desktops run on the profile home with no inherited keys', () => {
    const paths = profilePaths('/tb/wt');
    const env = profileDesktopEnv({ baseEnv: userEnv, paths, ports: { renderer: 1, payments: 2, systemProxy: 3, claudeGateway: 4 }, instance: 'x' });
    assert.equal(env.HOME, paths.home);
    assert.equal(env.ANTSEED_IDENTITY_HEX, undefined);
  });

  it('keeps toolchains on the real home and tolerates an unset HOME', () => {
    assert.deepEqual(toolchainEnv({ HOME: '/u' }), { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', VOLTA_HOME: '/u/.volta', COREPACK_HOME: '/u/.cache/node/corepack' });
    assert.deepEqual(toolchainEnv({}), { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' });
    assert.equal(toolchainEnv({ HOME: '/u', VOLTA_HOME: '/v' }).VOLTA_HOME, '/v');
  });
});
