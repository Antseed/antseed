import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLockTimeoutError, withFileLock } from './file-lock.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function lockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ants-lock-'));
  dirs.push(dir);
  return join(dir, 'nested', 'test.lock');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('file lock', () => {
  it('runs callers in this process one at a time and removes the lock afterwards', async () => {
    const lock = await lockPath();
    const order: string[] = [];
    const task = (name: string) => withFileLock(lock, async () => {
      order.push(`${name}:start`);
      await sleep(10);
      order.push(`${name}:end`);
      return name;
    });
    expect(await Promise.all([task('a'), task('b'), task('c')])).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    await expect(readFile(lock, 'utf8')).rejects.toThrow();
  });

  it('releases the lock when the task throws', async () => {
    const lock = await lockPath();
    await expect(withFileLock(lock, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withFileLock(lock, async () => 'next')).toBe('next');
  });

  it('waits for a live process holding the lock, and times out', async () => {
    const lock = await lockPath();
    await withFileLock(lock, async () => undefined); // creates the directory
    await writeFile(lock, JSON.stringify({ pid: process.ppid }));
    await expect(withFileLock(lock, async () => 'never', { timeoutMs: 80, retryMs: 10 })).rejects.toBeInstanceOf(FileLockTimeoutError);
    const waiting = withFileLock(lock, async () => 'after', { retryMs: 10 });
    await sleep(30);
    await rm(lock);
    expect(await waiting).toBe('after');
  });

  it('breaks a lock left by a dead process or held past the stale window', async () => {
    const lock = await lockPath();
    await withFileLock(lock, async () => undefined);
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12_345 })); // above any real pid
    expect(await withFileLock(lock, async () => 'dead owner', { timeoutMs: 200 })).toBe('dead owner');
    await writeFile(lock, JSON.stringify({ pid: process.ppid }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await withFileLock(lock, async () => 'stale', { timeoutMs: 200, staleMs: 30_000 })).toBe('stale');
  });
});
