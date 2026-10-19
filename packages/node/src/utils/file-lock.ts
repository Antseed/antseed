import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Tails of the in-process queues, one per lock path. Kept on `globalThis` so
 * two bundled copies of this module in one process still queue together
 * (a lock held by this pid is otherwise treated as left over).
 */
const QUEUES = Symbol.for('antseed.fileLock.queues');
const queues: Map<string, Promise<void>> = ((globalThis as Record<symbol, unknown>)[QUEUES] ??= new Map()) as Map<string, Promise<void>>;

export interface FileLockOptions {
  /**
   * A lock whose heartbeat stopped for this long is broken: its owner is hung,
   * or crashed and its pid was recycled. A live holder refreshes it well within.
   */
  staleMs?: number;
  /** Give up waiting for another holder after this long. */
  timeoutMs?: number;
  /** Poll interval while another process holds the lock. */
  retryMs?: number;
  /**
   * Test hook: runs before each attempt to claim an abandoned lock (`claim`
   * is the claim file about to be created), so tests can line up competing
   * reclaimers.
   * @internal
   */
  beforeReclaim?: (claim: string) => Promise<void>;
}

/** Thrown when another process kept the lock for longer than `timeoutMs`. */
export class FileLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`Another Antseed process is holding ${lockPath}. Try again in a moment.`);
    this.name = 'FileLockTimeoutError';
    this.lockPath = lockPath;
  }
}

/**
 * Run `task` while holding `lockPath`: callers in this process queue behind
 * each other, and other processes sharing the directory (CLI, Desktop, the
 * dashboard) are kept out by an exclusively created lock file holding the
 * owner's pid. While `task` runs, the holder refreshes the file's mtime, so
 * a live owner is never evicted however long it takes; contenders time out
 * instead. Only a lock whose owner is gone, or whose heartbeat stopped for
 * `staleMs`, is broken.
 */
export async function withFileLock<T>(lockPath: string, task: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const previous = queues.get(lockPath) ?? Promise.resolve();
  let done!: () => void;
  const gate = new Promise<void>((resolve) => { done = resolve; });
  const tail = previous.then(() => gate);
  queues.set(lockPath, tail);
  await previous;
  try {
    const staleMs = options.staleMs ?? 30_000;
    const token = await acquire(lockPath, staleMs, options);
    const heartbeat = setInterval(() => { void refresh(lockPath, token); }, Math.max(10, Math.floor(staleMs / 3)));
    heartbeat.unref?.();
    try {
      return await task();
    } finally {
      clearInterval(heartbeat);
      await releaseLock(lockPath, token);
    }
  } finally {
    done();
    if (queues.get(lockPath) === tail) queues.delete(lockPath);
  }
}

async function acquire(lockPath: string, staleMs: number, options: FileLockOptions): Promise<string> {
  const { timeoutMs = 10_000, retryMs = 50 } = options;
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
    if (await breakIfStale(lockPath, staleMs, options.beforeReclaim)) continue;
    if (Date.now() >= deadline) throw new FileLockTimeoutError(lockPath);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}

/** Keep our lock's mtime fresh; never touch a lock another process took. */
async function refresh(lockPath: string, token: string): Promise<void> {
  try {
    if (await readFile(lockPath, 'utf8') !== token) return;
    const now = new Date();
    await utimes(lockPath, now, now);
  } catch {
    // released meanwhile
  }
}

type LockSnapshot = { content: string; mtimeMs: number };

async function inspect(path: string): Promise<LockSnapshot | null> {
  try {
    const [content, { mtimeMs }] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { content, mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Abandoned: left by a dead process, by this process (queued callers never
 * overlap), or not refreshed for `staleMs` (its owner is hung, or crashed and
 * its pid now belongs to another process). A lock being written has no
 * content yet; its owner gets the stale window.
 */
function abandoned(lock: LockSnapshot, staleMs: number): boolean {
  const pid = ownerPid(lock.content);
  return (pid !== null && (pid === process.pid || !alive(pid))) || Date.now() - lock.mtimeMs > staleMs;
}

/**
 * Remove an abandoned lock. A refreshed lock of a live owner is never removed.
 *
 * Reading a lock and unlinking its path are two steps, so two reclaimers that
 * judged the same lock abandoned could otherwise both unlink it, the second
 * deleting the fresh lock the first just took. So only the one process that
 * exclusively creates `<lock>.reclaim-<digest of the abandoned content>` may
 * remove it. That name belongs to this one abandoned lock, so a claim never
 * has to be deleted for another reclaimer to proceed: whoever loses the
 * create waits and re-reads. If the claimant itself died, its claim is
 * abandoned in turn and is claimed the same way, one level deeper
 * (`<claim>-<digest of the claim>`). Claims are cleaned up after the lock is
 * removed; a late reclaimer that recreates one finds a different lock and
 * leaves it alone.
 */
async function breakIfStale(lockPath: string, staleMs: number, beforeReclaim?: (claim: string) => Promise<void>): Promise<boolean> {
  const seen = await inspect(lockPath);
  if (!seen) return true; // released meanwhile: retry at once
  if (!abandoned(seen, staleMs)) return false;
  const base = `${lockPath}.reclaim-${digest(seen.content)}`;
  const claim = await claimAbandoned(base, staleMs, beforeReclaim);
  if (claim === 'busy') return false; // a live process is reclaiming it
  if (claim === 'won') {
    // Only the claimant removes the lock it claimed; retaken meanwhile, it is judged afresh.
    const current = await inspect(lockPath);
    if (current && current.content === seen.content) await rm(lockPath, { force: true });
    await removeClaims(base);
  }
  return true;
}

/**
 * Exclusively create `path`, or claim it in turn when its creator died.
 * 'gone' means the claim was cleaned up meanwhile: the lock was reclaimed.
 */
async function claimAbandoned(path: string, staleMs: number, beforeReclaim?: (claim: string) => Promise<void>): Promise<'won' | 'busy' | 'gone'> {
  for (let depth = 0; depth < 8; depth += 1) {
    await beforeReclaim?.(path);
    const token = JSON.stringify({ pid: process.pid, at: Date.now(), nonce: Math.random().toString(36).slice(2) });
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(token); } finally { await handle.close(); }
      return 'won';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const held = await inspect(path);
    if (!held) return 'gone';
    // A claim is held for a few file operations only, so it is abandoned only
    // when its creator died (or is this process), never for its age; an empty
    // one only when its creator never wrote its pid within the stale window.
    const pid = ownerPid(held.content);
    const dead = pid !== null ? pid === process.pid || !alive(pid) : Date.now() - held.mtimeMs > staleMs;
    if (!dead) return 'busy';
    path = `${path}-${digest(held.content)}`;
  }
  return 'busy';
}

/** Remove `base` and every deeper claim on it. */
async function removeClaims(base: string): Promise<void> {
  const prefix = basename(base);
  const names = await readdir(dirname(base)).catch(() => [] as string[]);
  await Promise.all(names.filter((name) => name.startsWith(prefix)).map((name) => rm(join(dirname(base), name), { force: true })));
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
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
