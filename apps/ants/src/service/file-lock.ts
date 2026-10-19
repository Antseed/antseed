import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Tails of the in-process queues, one per lock path. */
const queues = new Map<string, Promise<void>>();

export interface FileLockOptions {
  /** A lock file older than this is from a hung or crashed holder and is broken. */
  staleMs?: number;
  /** Give up waiting for another holder after this long. */
  timeoutMs?: number;
  /** Poll interval while another process holds the lock. */
  retryMs?: number;
}

/** Thrown when another process kept the lock for longer than `timeoutMs`. */
export class FileLockTimeoutError extends Error {
  constructor(readonly lockPath: string) {
    super(`Another Antseed process is holding ${lockPath}. Try again in a moment.`);
    this.name = 'FileLockTimeoutError';
  }
}

/**
 * Run `task` while holding `lockPath`: callers in this process queue behind
 * each other, and other processes sharing the directory (CLI, Desktop, the
 * dashboard) are kept out by an exclusively created lock file holding the
 * owner's pid. A lock whose owner is gone or that outlived `staleMs` is broken.
 */
export async function withFileLock<T>(lockPath: string, task: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const previous = queues.get(lockPath) ?? Promise.resolve();
  let done!: () => void;
  const gate = new Promise<void>((resolve) => { done = resolve; });
  const tail = previous.then(() => gate);
  queues.set(lockPath, tail);
  await previous;
  try {
    const token = await acquire(lockPath, options);
    try {
      return await task();
    } finally {
      await releaseLock(lockPath, token);
    }
  } finally {
    done();
    if (queues.get(lockPath) === tail) queues.delete(lockPath);
  }
}

async function acquire(lockPath: string, options: FileLockOptions): Promise<string> {
  const { staleMs = 30_000, timeoutMs = 10_000, retryMs = 50 } = options;
  await mkdir(dirname(lockPath), { recursive: true });
  const token = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: Math.random().toString(36).slice(2) });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try { await handle.writeFile(token); } finally { await handle.close(); }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (await breakIfStale(lockPath, staleMs)) continue;
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

/** Remove a lock left by a dead process, by this process (queued callers never overlap), or held too long. */
async function breakIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  let content: string;
  let mtimeMs: number;
  try {
    [content, { mtimeMs }] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
  } catch {
    return true; // released meanwhile: retry at once
  }
  const pid = ownerPid(content);
  // A lock being written has no content yet; give its owner the stale window.
  const stale = Date.now() - mtimeMs > staleMs || (pid !== null && (pid === process.pid || !alive(pid)));
  if (!stale) return false;
  // Only remove the lock we judged stale, not one a racing process just took.
  if (await readFile(lockPath, 'utf8').catch(() => null) !== content) return true;
  await rm(lockPath, { force: true });
  return true;
}

function ownerPid(content: string): number | null {
  try {
    const pid = (JSON.parse(content) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  // Never remove a lock another process took after ours was broken as stale.
  if (await readFile(lockPath, 'utf8').catch(() => null) === token) await rm(lockPath, { force: true });
}
