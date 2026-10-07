import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withLock, isOwnedProcessAlive } from './lock.mjs';
import { readJson } from './manifest.mjs';

const BASE_BLOCKS_PER_HOUR = 1_800;
export const MAX_CACHED_BLOCK_AGE_HOURS = 72;
const HEAD_SAFETY_BLOCKS = 10;
export const KEEP_CACHED_BLOCKS = 3;
const CACHE_FILES = ['storage.json', 'block.json'];

export function sharedCacheHome(env = process.env, root) {
  return env.ANTSEED_SANDBOX_CACHE_DIR?.trim() || join(root, '.cache', 'anvil');
}

export function legacyCacheHome(home = homedir()) {
  return join(home, '.antseed-e2e', 'anvil-home');
}

export function blocksDir(anvilHome) {
  return join(anvilHome, '.foundry', 'cache', 'rpc', 'base');
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

export async function listCachedBlocks(anvilHome) {
  let entries;
  try {
    entries = await readdir(blocksDir(anvilHome));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const blocks = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const bytes = await fileSize(join(blocksDir(anvilHome), entry, 'storage.json'));
    if (bytes > 0) blocks.push({ block: Number(entry), bytes });
  }
  return blocks.sort((a, b) => b.block - a.block);
}

async function copyBlock(fromHome, toHome, block) {
  const from = join(blocksDir(fromHome), String(block));
  const to = join(blocksDir(toHome), String(block));
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const file of CACHE_FILES) {
    if (!(await fileSize(join(from, file)))) continue;
    const tmp = join(to, `${file}.tmp-${process.pid}`);
    await copyFile(join(from, file), tmp);
    await rename(tmp, join(to, file));
  }
}

const lockPath = (cacheHome) => join(cacheHome, 'cache.lock');

/** Seeds an empty shared cache from the legacy fork-harness cache. Only reads the legacy location. */
export async function seedFromLegacy(cacheHome, legacyHome = legacyCacheHome()) {
  await mkdir(blocksDir(cacheHome), { recursive: true, mode: 0o700 });
  return withLock(lockPath(cacheHome), async () => {
    if ((await listCachedBlocks(cacheHome)).length > 0) return null;
    const newest = (await listCachedBlocks(legacyHome))[0];
    if (!newest) return null;
    await copyBlock(legacyHome, cacheHome, newest.block);
    return newest.block;
  });
}

async function fetchHead(forkUrl, fetchImpl) {
  const response = await fetchImpl(forkUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    signal: AbortSignal.timeout(15_000),
  });
  const value = await response.json();
  if (value.error || typeof value.result !== 'string') throw new Error('Could not read the Base head block from the fork RPC');
  return Number(BigInt(value.result));
}

/** Explicit block wins; otherwise reuse the newest warm block (<72h old) or pin just behind head. */
export async function resolveForkBlock({ forkUrl, cacheHome, explicitBlock, refresh = false, fetchImpl = fetch }) {
  const cached = await listCachedBlocks(cacheHome);
  if (explicitBlock != null) {
    const block = Number(explicitBlock);
    const warm = cached.some((entry) => entry.block === block);
    return { block, source: warm ? 'explicit (warm cache)' : 'explicit (cold cache)', warm };
  }
  const head = await fetchHead(forkUrl, fetchImpl);
  const newest = cached[0];
  if (!refresh && newest && head - newest.block <= MAX_CACHED_BLOCK_AGE_HOURS * BASE_BLOCKS_PER_HOUR) {
    return { block: newest.block, source: 'warm cache', warm: true, ageHours: Math.round((head - newest.block) / BASE_BLOCKS_PER_HOUR) };
  }
  return { block: head - HEAD_SAFETY_BLOCKS, source: refresh ? 'refreshed' : newest ? 'cache too old' : 'no cache yet', warm: false };
}

/** Copies the warm block into the sandbox's private Anvil HOME. Anvil never writes the shared cache. */
export async function copyIn(cacheHome, sandboxAnvilHome, block) {
  await mkdir(blocksDir(sandboxAnvilHome), { recursive: true, mode: 0o700 });
  if (!(await fileSize(join(blocksDir(cacheHome), String(block), 'storage.json')))) return false;
  await withLock(lockPath(cacheHome), () => copyBlock(cacheHome, sandboxAnvilHome, block));
  return true;
}

/**
 * After Anvil exits, publishes the sandbox's (possibly warmer) copy back to the shared cache under
 * the cache lock with an atomic rename. A smaller file never replaces a larger one.
 */
export async function writeBack(cacheHome, sandboxAnvilHome, block) {
  const ours = await fileSize(join(blocksDir(sandboxAnvilHome), String(block), 'storage.json'));
  if (!ours) return 'nothing-to-write';
  await mkdir(blocksDir(cacheHome), { recursive: true, mode: 0o700 });
  return withLock(lockPath(cacheHome), async () => {
    const shared = await fileSize(join(blocksDir(cacheHome), String(block), 'storage.json'));
    if (shared >= ours) return 'kept-shared';
    await copyBlock(sandboxAnvilHome, cacheHome, block);
    return 'updated';
  });
}

/** Fork blocks pinned by sandboxes that are still running (live owned supervisor). */
export async function blocksInUse(root, deps = {}) {
  let entries;
  try {
    entries = await readdir(root);
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
  const used = new Set();
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const manifest = await readJson(join(root, entry, 'manifest.json')).catch(() => null);
    if (manifest?.running && manifest.forkBlock && isOwnedProcessAlive(manifest.supervisor, deps)) used.add(Number(manifest.forkBlock));
  }
  return used;
}

/** Keeps the newest blocks and anything a live sandbox uses. */
export async function pruneCache(cacheHome, { inUse = new Set(), keep = KEEP_CACHED_BLOCKS } = {}) {
  return withLock(lockPath(cacheHome), async () => {
    const removed = [];
    for (const { block } of (await listCachedBlocks(cacheHome)).slice(keep)) {
      if (inUse.has(block)) continue;
      await rm(join(blocksDir(cacheHome), String(block)), { recursive: true, force: true });
      removed.push(block);
    }
    return removed;
  });
}
