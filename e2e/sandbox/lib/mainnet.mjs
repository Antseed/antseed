import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { isolatedEnv } from './env.mjs';
import { acquireLock, releaseLock } from './lock.mjs';
import { saveJson } from './manifest.mjs';

/** Test wallet for the real network: a 64-hex private key, shell first, then the worktree's gitignored .env.local. */
export const MAINNET_WALLET_ENV = 'ANTSEED_SANDBOX_MAINNET_IDENTITY_HEX';
/** Hard cap on what one buyer channel may reserve, in USDC (applied as payments.maxReserveAmountUsdc). */
export const MAINNET_RESERVE_CAP_ENV = 'ANTSEED_SANDBOX_MAINNET_MAX_RESERVE_USDC';
export const DEFAULT_RESERVE_CAP_USDC = '0.50';
export const MAINNET_PROFILE = 'mainnet';

export function resolveMainnetWallet({ env = process.env, fileValues = {}, envFile = '.env.local' } = {}) {
  const fromShell = env[MAINNET_WALLET_ENV]?.trim();
  const raw = fromShell || fileValues[MAINNET_WALLET_ENV]?.trim();
  if (!raw) {
    throw new Error(`${MAINNET_WALLET_ENV} is required: the private key (64 hex) of a dedicated, funded test buyer wallet. Put it in ${envFile} or export it. Never use your personal wallet.`);
  }
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${MAINNET_WALLET_ENV} must be 64 hex characters (optionally 0x-prefixed)`);
  return { hex: hex.toLowerCase(), source: fromShell ? 'shell' : envFile };
}

export function resolveReserveCap({ env = process.env, fileValues = {} } = {}) {
  const raw = env[MAINNET_RESERVE_CAP_ENV]?.trim() || fileValues[MAINNET_RESERVE_CAP_ENV]?.trim() || DEFAULT_RESERVE_CAP_USDC;
  if (!/^\d+(\.\d{1,6})?$/.test(raw) || Number(raw) <= 0 || Number(raw) > 5) {
    throw new Error(`${MAINNET_RESERVE_CAP_ENV} must be a USDC amount above 0 and at most 5`);
  }
  const [whole, fraction = ''] = raw.split('.');
  return { usdc: raw, micros: BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0')) };
}

/** Paths for a full-desktop profile: its own HOME, so ~/.antseed (identity, config, chats, plugins) is the profile's. */
export function profilePaths(sandboxDir, profile = MAINNET_PROFILE) {
  const dir = join(sandboxDir, 'profiles', profile);
  const home = join(dir, 'home');
  return {
    dir,
    home,
    antseed: join(home, '.antseed'),
    config: join(home, '.antseed', 'config.json'),
    identityKey: join(home, '.antseed', 'identity.key'),
    pluginsDir: join(home, '.antseed', 'plugins'),
    electron: join(dir, 'electron'),
    systemProxy: join(dir, 'system-proxy'),
    state: join(dir, 'profile.json'),
    logs: join(dir, 'logs'),
  };
}

/**
 * Seeds the profile's ~/.antseed: the test wallet as a plaintext identity.key (the desktop migrates it into
 * its encrypted store under the mock keychain on first launch), and a config capped for real-funds testing.
 * Existing settings the desktop wrote are kept; only the sandbox-owned keys are (re)applied.
 */
export async function seedProfile(paths, { walletHex, buyerProxyPort, reserveCapMicros }) {
  await mkdir(paths.antseed, { recursive: true, mode: 0o700 });
  let existing = {};
  try { existing = JSON.parse(await readFile(paths.config, 'utf8')); } catch { /* first launch */ }
  const buyer = { ...(existing.buyer ?? {}), proxyPort: buyerProxyPort };
  const crypto = { ...(existing.payments?.crypto ?? {}), chainId: 'base-mainnet' };
  const config = {
    ...existing,
    buyer,
    payments: {
      ...(existing.payments ?? {}),
      preferredMethod: 'crypto',
      crypto,
      maxReserveAmountUsdc: String(reserveCapMicros),
      maxPerRequestUsdc: String(reserveCapMicros),
    },
  };
  await saveJson(paths.config, config);
  let hasEncrypted = false;
  try { await readFile(join(paths.antseed, 'identity.enc')); hasEncrypted = true; } catch { /* not migrated yet */ }
  if (!hasEncrypted) await writeFile(paths.identityKey, `${walletHex}\n`, { mode: 0o600 });
  return config;
}

const WORKSPACE_PACKAGES = { 'router-local': 'plugins/router-local', 'router-core': 'packages/router-core', node: 'packages/node', 'buyer-core': 'packages/buyer-core', protocol: 'packages/protocol', 'api-adapter': 'packages/api-adapter', 'antseed-verifier': 'packages/antseed-verifier' };

/**
 * Makes the profile's ~/.antseed/plugins resolve the router plugin to this worktree's build, so the desktop's
 * own buyer (`antseed buyer start`, spawned by the desktop) runs the code under test. The verifier is linked too,
 * because the buyer otherwise npm-installs it into this directory. Third-party dependencies
 * link to the repo's hoisted node_modules; @antseed/* link to the workspace packages. Nothing is downloaded.
 * Only leaf packages are links (scope directories are real), so an npm run in the profile can only remove
 * links, never prune files inside the worktree's node_modules.
 */
export async function linkWorktreePlugins(pluginsDir, repo) {
  const nodeModules = join(pluginsDir, 'node_modules');
  await rm(nodeModules, { recursive: true, force: true });
  await mkdir(join(nodeModules, '@antseed'), { recursive: true });
  await writeFile(join(pluginsDir, 'package.json'), `${JSON.stringify({ name: 'antseed-plugins', version: '1.0.0', private: true, dependencies: { '@antseed/router-local': `file:${join(repo, WORKSPACE_PACKAGES['router-local'])}` } }, null, 2)}\n`);
  const repoModules = join(repo, 'node_modules');
  for (const entry of await readdir(repoModules)) {
    if (entry.startsWith('.') || entry === '@antseed') continue;
    if (!entry.startsWith('@')) {
      await symlink(join(repoModules, entry), join(nodeModules, entry));
      continue;
    }
    await mkdir(join(nodeModules, entry));
    for (const scoped of await readdir(join(repoModules, entry))) {
      await symlink(join(repoModules, entry, scoped), join(nodeModules, entry, scoped));
    }
  }
  for (const [name, dir] of Object.entries(WORKSPACE_PACKAGES)) {
    if (!existsSync(join(repo, dir, 'dist'))) throw new Error(`Build first (pnpm run build): ${dir}/dist is missing`);
    if (name !== 'router-local') await symlink(join(repo, dir), join(nodeModules, '@antseed', name));
  }
  await linkPluginWithResolvedPins(repo, join(nodeModules, '@antseed', 'router-local'));
}

/**
 * The plugin itself is a real directory whose package.json pins its @antseed/* dependencies to the worktree's
 * versions instead of `workspace:*`. The CLI compares those pins with its own core versions and runs
 * `npm install <plugin>@latest` on a mismatch, which would replace the worktree build with the npm release.
 */
async function linkPluginWithResolvedPins(repo, target) {
  const source = join(repo, WORKSPACE_PACKAGES['router-local']);
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const versionOf = async (name) => JSON.parse(await readFile(join(repo, WORKSPACE_PACKAGES[name.replace('@antseed/', '')], 'package.json'), 'utf8')).version;
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (String(range).startsWith('workspace:')) manifest[field][dep] = await versionOf(dep);
    }
  }
  await mkdir(target);
  await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const entry of await readdir(source)) {
    if (entry === 'package.json' || entry === 'node_modules') continue;
    await symlink(join(source, entry), join(target, entry));
  }
}

export function walletAddress(hex) {
  const { Wallet } = createRequire(import.meta.url)('ethers');
  return new Wallet(`0x${hex}`).address;
}

/** Environment for the full desktop on a profile: real network, its own buyer, nothing machine-wide. */
export function profileDesktopEnv({ baseEnv = process.env, paths, ports, instance }) {
  const env = isolatedEnv(baseEnv, paths.home, {
    VOLTA_HOME: baseEnv.VOLTA_HOME || join(baseEnv.HOME ?? '', '.volta'),
    COREPACK_HOME: baseEnv.COREPACK_HOME || join(baseEnv.XDG_CACHE_HOME || join(baseEnv.HOME ?? '', '.cache'), 'node', 'corepack'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    ANTSEED_DESKTOP_ISOLATED_PROFILE: '1',
    ANTSEED_DESKTOP_INSTANCE: instance,
    ANTSEED_DESKTOP_USER_DATA_DIR: paths.electron,
    ANTSEED_SYSTEM_PROXY_DATA_DIR: paths.systemProxy,
    ANTSEED_DESKTOP_RENDERER_PORT: String(ports.renderer),
    ANTSEED_PAYMENTS_PORT: String(ports.payments),
    ANTSEED_SYSTEM_PROXY_PORT: String(ports.systemProxy),
    ANTSEED_CLAUDE_GATEWAY_PORT: String(ports.claudeGateway),
    TELEMETRY_ENABLED: '0',
  });
  delete env.ANTSEED_SKIP_PLUGIN_UPDATE_CHECK;
  delete env.VITE_DEV_SERVER_URL;
  return env;
}

/**
 * Prepares (or reuses) the mainnet profile: wallet from the env, a lock so two worktrees never drive the same
 * wallet at once, worktree plugins, and the capped config. Returns everything a launcher needs.
 */
export async function prepareMainnetProfile({ sandboxDir, root, repo, env = process.env, fileValues = {}, envFile, fresh = false, buyerProxyPort }) {
  const wallet = resolveMainnetWallet({ env, fileValues, envFile });
  const cap = resolveReserveCap({ env, fileValues });
  const address = walletAddress(wallet.hex);
  const paths = profilePaths(sandboxDir);
  const lockPath = join(root, '.wallets', `${address.toLowerCase()}.lock`);
  const lock = await acquireLock(lockPath, { role: 'mainnet-profile', sandbox: sandboxDir });
  if (lock.state !== 'acquired') throw new Error(`Test wallet ${address} is in use by ${lock.holder.sandbox ?? 'another sandbox'} (pid ${lock.holder.pid})`);
  try {
    if (fresh) await rm(paths.dir, { recursive: true, force: true });
    const previous = await readFile(paths.state, 'utf8').then(JSON.parse).catch(() => null);
    if (previous?.address && previous.address !== address) {
      throw new Error(`The mainnet profile holds wallet ${previous.address}, not ${address}; rerun with --fresh to reset it`);
    }
    for (const dir of [paths.home, paths.antseed, paths.pluginsDir, paths.electron, paths.systemProxy, paths.logs]) await mkdir(dir, { recursive: true, mode: 0o700 });
    await linkWorktreePlugins(paths.pluginsDir, repo);
    await seedProfile(paths, { walletHex: wallet.hex, buyerProxyPort, reserveCapMicros: cap.micros });
    await writeFile(paths.state, `${JSON.stringify({ address, walletSource: wallet.source, reserveCapUsdc: cap.usdc, buyerProxyPort, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    await releaseLock(lockPath, lock.entry);
    throw error;
  }
  return { paths, address, cap, walletSource: wallet.source, release: () => releaseLock(lockPath, lock.entry) };
}
