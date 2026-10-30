import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { blocksDir, blocksInUse, copyIn, listCachedBlocks, pruneCache, resolveForkBlock, seedFromLegacy, writeBack } from '../lib/cache.mjs';
import { acquireLock, releaseLock } from '../lib/lock.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'sandbox-cache-'));
after(() => rm(tmp, { recursive: true, force: true }));
let counter = 0;
const home = () => join(tmp, `h${counter++}`);

async function putBlock(anvilHome, block, bytes) {
  const dir = join(blocksDir(anvilHome), String(block));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'storage.json'), 'x'.repeat(bytes));
  await writeFile(join(dir, 'block.json'), '{}');
}

async function snapshot(dir) {
  const out = {};
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else { const info = await stat(full); out[full] = `${info.size}:${info.mtimeMs}`; }
    }
  };
  await walk(dir);
  return out;
}

describe('fork cache', () => {
  it('seeds an empty shared cache from the newest legacy block without writing the legacy dir', async () => {
    const legacy = home();
    const shared = home();
    await putBlock(legacy, 100, 10);
    await putBlock(legacy, 200, 20);
    const before = await snapshot(legacy);
    assert.equal(await seedFromLegacy(shared, legacy), 200);
    assert.deepEqual((await listCachedBlocks(shared)).map((entry) => entry.block), [200]);
    assert.deepEqual(await snapshot(legacy), before, 'legacy cache untouched');
    assert.equal(await seedFromLegacy(shared, legacy), null, 'already seeded');
    assert.equal(await seedFromLegacy(home(), home()), null, 'no legacy cache');
  });

  it('copies a warm block into the private home; cold blocks are a no-op', async () => {
    const shared = home();
    const mine = home();
    await putBlock(shared, 300, 30);
    assert.equal(await copyIn(shared, mine, 300), true);
    assert.equal((await readFile(join(blocksDir(mine), '300', 'storage.json'), 'utf8')).length, 30);
    assert.equal(await copyIn(shared, mine, 999), false);
  });

  it('writes back only a larger copy, atomically, under the cache lock', async () => {
    const shared = home();
    const mine = home();
    await putBlock(shared, 400, 50);
    await putBlock(mine, 400, 40);
    assert.equal(await writeBack(shared, mine, 400), 'kept-shared');
    await putBlock(mine, 400, 80);
    assert.equal(await writeBack(shared, mine, 400), 'updated');
    assert.equal((await readFile(join(blocksDir(shared), '400', 'storage.json'), 'utf8')).length, 80);
    assert.equal(await writeBack(shared, home(), 400), 'nothing-to-write');
    const leftovers = (await readdir(join(blocksDir(shared), '400'))).filter((file) => file.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });

  it('waits for a held cache lock before writing', async () => {
    const shared = home();
    const mine = home();
    await putBlock(mine, 500, 10);
    await mkdir(shared, { recursive: true });
    const held = await acquireLock(join(shared, 'cache.lock'));
    let done = false;
    const pending = writeBack(shared, mine, 500).then((result) => { done = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(done, false, 'blocked while another process holds the lock');
    await releaseLock(join(shared, 'cache.lock'), held.entry);
    assert.equal(await pending, 'updated');
  });

  it('prunes old blocks but never one a live sandbox uses', async () => {
    const shared = home();
    for (const block of [1, 2, 3, 4, 5]) await putBlock(shared, block, 5);
    const removed = await pruneCache(shared, { keep: 2, inUse: new Set([2]) });
    assert.deepEqual(removed.sort(), [1, 3]);
    assert.deepEqual((await listCachedBlocks(shared)).map((entry) => entry.block), [5, 4, 2]);
  });

  it('finds blocks in use from running manifests with live owned supervisors only', async () => {
    const root = home();
    const write = async (name, manifest) => {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, 'manifest.json'), JSON.stringify(manifest));
    };
    await write('wt-live', { running: true, forkBlock: 10, supervisor: { pid: 1, startedAt: 'a' } });
    await write('wt-dead', { running: true, forkBlock: 20, supervisor: { pid: 2, startedAt: 'b' } });
    await write('wt-stopped', { running: false, forkBlock: 30, supervisor: { pid: 1, startedAt: 'a' } });
    await write('wt-reused', { running: true, forkBlock: 40, supervisor: { pid: 1, startedAt: 'other' } });
    await mkdir(join(root, '.cache'), { recursive: true });
    const deps = { isPidAlive: (pid) => pid === 1, processStartTime: (pid) => (pid === 1 ? 'a' : null) };
    assert.deepEqual([...(await blocksInUse(root, deps))], [10]);
    assert.deepEqual([...(await blocksInUse(join(root, 'missing'), deps))], []);
  });

  it('resolves the fork block: explicit, warm cache, or behind head', async () => {
    const shared = home();
    const head = 1_000_000;
    const fetchImpl = async () => ({ json: async () => ({ result: `0x${head.toString(16)}` }) });
    assert.deepEqual(await resolveForkBlock({ forkUrl: 'x', cacheHome: shared, explicitBlock: 5, fetchImpl }), { block: 5, source: 'explicit (cold cache)', warm: false });
    assert.equal((await resolveForkBlock({ forkUrl: 'x', cacheHome: shared, fetchImpl })).block, head - 10);
    await putBlock(shared, head - 1000, 5);
    const warm = await resolveForkBlock({ forkUrl: 'x', cacheHome: shared, fetchImpl });
    assert.equal(warm.block, head - 1000);
    assert.equal(warm.warm, true);
    assert.equal((await resolveForkBlock({ forkUrl: 'x', cacheHome: shared, fetchImpl, refresh: true })).block, head - 10);
    await rm(join(blocksDir(shared), String(head - 1000)), { recursive: true });
    await putBlock(shared, head - 200_000, 5);
    assert.equal((await resolveForkBlock({ forkUrl: 'x', cacheHome: shared, fetchImpl })).source, 'cache too old');
  });
});
