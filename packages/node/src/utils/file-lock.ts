import { open, rm, stat } from 'node:fs/promises';

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
    if (await isStale(lockPath, staleMs)) {
      await rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockPath}; remove it if no Antseed process is editing ${path}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  try {
    return await task();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > staleMs;
  } catch (err) {
    // Released between our attempt and this check: try again right away.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}
