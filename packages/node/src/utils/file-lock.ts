import { randomUUID } from 'node:crypto';
import { link, open, rename, rm, stat } from 'node:fs/promises';

export interface FileLockOptions {
  /** Give up waiting for another holder after this long. Default: 10 seconds. */
  timeoutMs?: number;
  /** A lock file older than this is treated as left behind by a crashed process. Default: 30 seconds. */
  staleMs?: number;
}

const RETRY_MS = 25;
const queues = new Map<string, Promise<void>>();

/**
 * Runs `task` while holding `<path>.lock`, so read-modify-write edits of one
 * file from different processes (CLI, gateway, payments page) never drop
 * each other's changes. Callers in the same process queue up behind each
 * other first, and only the head of the queue competes for the lock file.
 */
export async function withFileLock<T>(path: string, task: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const run = previous.then(() => holdingLockFile(path, task, options));
  const settled = run.then(() => undefined, () => undefined);
  queues.set(path, settled);
  try {
    return await run;
  } finally {
    if (queues.get(path) === settled) queues.delete(path);
  }
}

async function holdingLockFile<T>(path: string, task: () => Promise<T>, options: FileLockOptions): Promise<T> {
  const lockPath = `${path}.lock`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (await takeOverStale(lockPath, staleMs)) continue;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockPath}; remove it if no Antseed process is editing ${path}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  try {
    return await task();
  } finally {
    await rm(lockPath, { force: true });
  }
}

/**
 * Clears a lock left behind by a crashed process, or reports that the lock
 * was released meanwhile; either way the caller tries to take it again.
 * The lock is first moved aside, which only one waiter can do; if what got
 * moved turns out to be a fresh lock another waiter just took, it is put
 * back, so a live lock is never deleted.
 */
async function takeOverStale(lockPath: string, staleMs: number): Promise<boolean> {
  const seen = await mtimeMs(lockPath);
  if (seen === null) return true;
  if (Date.now() - seen <= staleMs) return false;
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
  const moved = await mtimeMs(aside);
  if (moved !== null && Date.now() - moved <= staleMs) {
    // Restore it unless someone already holds a newer lock.
    await link(aside, lockPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
  }
  await rm(aside, { force: true });
  return true;
}

async function mtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
