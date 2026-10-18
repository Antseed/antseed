import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { linkWorktreePlugins, MAINNET_RESERVE_CAP_ENV, MAINNET_WALLET_ENV, profileDesktopEnv, profilePaths, resolveMainnetWallet, resolveReserveCap, seedProfile, walletAddress } from '../lib/mainnet.mjs';
import { parseArgs } from '../lib/options.mjs';

const KEY = 'ab'.repeat(32);

describe('mainnet wallet and cap', () => {
  it('requires the wallet env and prefers the shell over .env.local', () => {
    assert.throws(() => resolveMainnetWallet({ env: {}, fileValues: {} }), new RegExp(MAINNET_WALLET_ENV));
    assert.deepEqual(resolveMainnetWallet({ env: {}, fileValues: { [MAINNET_WALLET_ENV]: `0x${KEY.toUpperCase()}` } }), { hex: KEY, source: '.env.local' });
    assert.equal(resolveMainnetWallet({ env: { [MAINNET_WALLET_ENV]: 'cd'.repeat(32) }, fileValues: { [MAINNET_WALLET_ENV]: KEY } }).source, 'shell');
    assert.throws(() => resolveMainnetWallet({ env: { [MAINNET_WALLET_ENV]: 'abc' } }), /64 hex/);
  });

  it('caps the channel reserve at 0.50 USDC by default and refuses more than 5', () => {
    assert.deepEqual(resolveReserveCap({ env: {} }), { usdc: '0.50', micros: 500_000n });
    assert.equal(resolveReserveCap({ env: { [MAINNET_RESERVE_CAP_ENV]: '1.25' } }).micros, 1_250_000n);
    for (const bad of ['0', '5.01', '-1', 'abc', '1.1234567']) {
      assert.throws(() => resolveReserveCap({ env: { [MAINNET_RESERVE_CAP_ENV]: bad } }), /at most 5/, bad);
    }
  });

  it('derives the wallet address', () => {
    assert.match(walletAddress(KEY), /^0x[0-9a-fA-F]{40}$/);
  });
});

describe('mainnet profile', () => {
  it('seeds a capped base-mainnet config and a private identity, keeping desktop settings', async () => {
    const paths = profilePaths(await mkdtemp(join(tmpdir(), 'sb-mainnet-')));
    await seedProfile(paths, { walletHex: KEY, buyerProxyPort: 18999, reserveCapMicros: 500_000n });
    await writeFile(paths.config, JSON.stringify({ ...JSON.parse(await readFile(paths.config, 'utf8')), ui: { theme: 'dark' } }));
    const config = await seedProfile(paths, { walletHex: KEY, buyerProxyPort: 19000, reserveCapMicros: 250_000n });
    assert.equal(config.buyer.proxyPort, 19000);
    assert.equal(config.payments.crypto.chainId, 'base-mainnet');
    assert.equal(config.payments.maxReserveAmountUsdc, '250000');
    assert.equal(config.payments.maxPerRequestUsdc, '250000');
    assert.deepEqual(config.ui, { theme: 'dark' });
    assert.equal((await readFile(paths.identityKey, 'utf8')).trim(), KEY);
    assert.equal((await stat(paths.identityKey)).mode & 0o777, 0o600);
  });

  it('gives the desktop its own HOME and the isolated-profile flag, without secrets', () => {
    const paths = profilePaths('/sb');
    const env = profileDesktopEnv({
      baseEnv: { PATH: '/bin', HOME: '/Users/me', OPENAI_API_KEY: 'sk', BASE_MAINNET_RPC_URL: 'https://x', [MAINNET_WALLET_ENV]: KEY, ANTSEED_SKIP_PLUGIN_UPDATE_CHECK: '1', VITE_DEV_SERVER_URL: 'http://x' },
      paths,
      ports: { renderer: 1, payments: 2, systemProxy: 3, claudeGateway: 4 },
      instance: 'sb-mainnet',
    });
    assert.equal(env.HOME, paths.home);
    assert.equal(env.ANTSEED_DESKTOP_ISOLATED_PROFILE, '1');
    assert.equal(env.ANTSEED_DESKTOP_ATTACH_ONLY, undefined);
    assert.equal(env.ANTSEED_DESKTOP_USER_DATA_DIR, paths.electron);
    assert.equal(env.COREPACK_HOME, '/Users/me/.cache/node/corepack');
    assert.equal(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
    for (const key of ['OPENAI_API_KEY', 'BASE_MAINNET_RPC_URL', MAINNET_WALLET_ENV, 'ANTSEED_SKIP_PLUGIN_UPDATE_CHECK', 'VITE_DEV_SERVER_URL']) assert.equal(env[key], undefined, key);
  });
});

describe('worktree plugin links', () => {
  it('pins the plugin to worktree versions and never links a whole scope directory', async () => {
    const repo = join(import.meta.dirname, '../../..');
    const pluginsDir = await mkdtemp(join(tmpdir(), 'sb-plugins-'));
    await linkWorktreePlugins(pluginsDir, repo);
    const nodeModules = join(pluginsDir, 'node_modules');
    const plugin = JSON.parse(await readFile(join(nodeModules, '@antseed/router-local/package.json'), 'utf8'));
    const routerCore = JSON.parse(await readFile(join(repo, 'packages/router-core/package.json'), 'utf8'));
    assert.equal(plugin.dependencies['@antseed/router-core'], routerCore.version);
    assert.equal((await lstat(join(nodeModules, '@antseed/router-local'))).isSymbolicLink(), false);
    assert.equal(await readlink(join(nodeModules, '@antseed/node')), join(repo, 'packages/node'));
    assert.equal(await readlink(join(nodeModules, '@antseed/antseed-verifier')), join(repo, 'packages/antseed-verifier'));
    const typesScope = await lstat(join(nodeModules, '@types'));
    assert.equal(typesScope.isSymbolicLink(), false);
    assert.equal(typesScope.isDirectory(), true);
  });
});

describe('mainnet options', () => {
  it('refuses the real network without --real-funds', () => {
    assert.throws(() => parseArgs(['mainnet']), /--real-funds/);
    assert.throws(() => parseArgs(['run', 'mainnet-smoke', '--chain', 'mainnet']), /--real-funds/);
    assert.throws(() => parseArgs(['up', '--chain', 'mainnet', '--real-funds']), /only for pnpm sandbox run/);
    assert.equal(parseArgs(['mainnet', '--real-funds', '--dev']).dev, true);
    assert.equal(parseArgs(['run', 'mainnet-smoke', '--chain', 'mainnet', '--real-funds']).chain, 'mainnet');
  });
});
