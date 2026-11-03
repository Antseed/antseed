import Database from 'better-sqlite3';

export interface FileLockOptions {
  /** Give up waiting for another holder after this long. Default: 10 seconds. */
  timeoutMs?: number;
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

/**
 * The lock is an exclusive SQLite transaction on `<path>.lock`, which rests on
 * the operating system's own file locks: only one process can hold it, and it
 * is released the moment its holder exits or crashes. Nothing ever has to
 * judge a lock stale or delete one, so a live holder can never lose it.
 */
async function holdingLockFile<T>(path: string, task: () => Promise<T>, options: FileLockOptions): Promise<T> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  const db = new Database(lockPath, { timeout: 0 });
  try {
    for (;;) {
      try {
        db.exec('BEGIN EXCLUSIVE');
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== 'SQLITE_BUSY') throw err;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockPath}; another Antseed process is editing ${path}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
    try {
      return await task();
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    db.close();
  }
}
