import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { uptime } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

/**
 * Tails of the in-process queues, one per lock path. Kept on `globalThis` so
 * two bundled copies of this module in one process still queue together
 * (a lock held by this pid is otherwise treated as left over).
 */
const QUEUES = Symbol.for('antseed.fileLock.queues');
const queues: Map<string, Promise<void>> = ((globalThis as Record<symbol, unknown>)[QUEUES] ??= new Map()) as Map<string, Promise<void>>;

export interface FileLockOptions {
  /**
   * A lock held this long by a running pid is checked for a recycled pid (one
   * that started after the lock was taken); a lock with no pid yet (its owner
   * died creating it) is broken. A lock whose owner still runs never is.
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
 * owner's pid. A running owner is never evicted, however long it takes or
 * however long it is paused, since it would keep writing after losing the
 * lock; contenders time out instead. Only a lock whose owner is gone (dead,
 * or its pid recycled) is broken.
 */
export async function withFileLock<T>(path: string, task: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  // One spelling per lock, so callers in this process always share its queue
  // (a lock held by this pid under another spelling would look left over).
  const lockPath = canonicalLockPath(path);
  const previous = queues.get(lockPath) ?? Promise.resolve();
  let done!: () => void;
  const gate = new Promise<void>((resolve) => { done = resolve; });
  const tail = previous.then(() => gate);
  queues.set(lockPath, tail);
  await previous;
  try {
    const staleMs = options.staleMs ?? 30_000;
    const token = await acquire(lockPath, staleMs, options);
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

/**
 * Absolute path with the directory's symlinks resolved (the directory is
 * created first). Synchronous, so callers still queue in call order.
 */
function canonicalLockPath(path: string): string {
  const absolute = resolvePath(path);
  mkdirSync(dirname(absolute), { recursive: true });
  return join(realpathSync(dirname(absolute)), basename(absolute));
}

async function acquire(lockPath: string, staleMs: number, options: FileLockOptions): Promise<string> {
  const { timeoutMs = 10_000, retryMs = 50 } = options;
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
 * overlap), or by a process whose pid now belongs to another one: the lock
 * predates this boot, or (checked once it is `staleMs` old) the pid's process
 * started after the lock was taken. A lock being written has no content yet;
 * its owner gets the stale window.
 */
async function abandoned(lock: LockSnapshot, staleMs: number): Promise<boolean> {
  const owner = ownerOf(lock.content);
  if (!owner) return Date.now() - lock.mtimeMs > staleMs;
  if (owner.pid === process.pid || !alive(owner.pid)) return true;
  if (owner.at === null || Date.now() - owner.at <= staleMs) return false;
  if (owner.at < Date.now() - uptime() * 1000) return true;
  // Contenders poll often; ask `ps` about the same owner once per stale window.
  const key = `${owner.pid}:${owner.at}`;
  let cached = starts.get(key);
  if (!cached || Date.now() - cached.checkedAt > staleMs) {
    cached = { checkedAt: Date.now(), started: processStart(owner.pid) };
    starts.set(key, cached);
    if (starts.size > 64) starts.delete(starts.keys().next().value!);
  }
  const started = await cached.started;
  return started !== null && started > owner.at + START_SLACK_MS;
}

/** `ps` reports elapsed time in whole seconds. */
const START_SLACK_MS = 2_000;
const starts = new Map<string, { checkedAt: number; started: Promise<number | null> }>();

/** When `pid` started (from `ps`, to the second), or null where unknown. */
function processStart(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'etime=', '-p', String(pid)], { timeout: 2_000 }, (error, stdout) => {
      // [[dd-]hh:]mm:ss
      const match = error ? null : /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(stdout);
      if (!match) return resolve(null);
      const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
      resolve(Date.now() - (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1000);
    });
  });
}

/**
 * Remove an abandoned lock. The lock of a running owner is never removed.
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
  if (!(await abandoned(seen, staleMs))) return false;
  const base = `${lockPath}.reclaim-${digest(seen.content)}`;
  const claim = await claimAbandoned(base, staleMs, beforeReclaim);
  if (claim === 'busy') return false; // a live process is reclaiming it
  if (claim === 'won') {
    // Only the claimant removes the lock it claimed, and only while it is still
    // that abandoned lock: retaken meanwhile, it is judged afresh.
    const current = await inspect(lockPath);
    if (current && current.content === seen.content && await abandoned(current, staleMs)) await rm(lockPath, { force: true });
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
    const pid = ownerOf(held.content)?.pid;
    const dead = pid !== undefined ? pid === process.pid || !alive(pid) : Date.now() - held.mtimeMs > staleMs;
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

/** The owner's pid and when it took the lock (null when not recorded). */
function ownerOf(content: string): { pid: number; at: number | null } | null {
  try {
    const { pid, at } = JSON.parse(content) as { pid?: unknown; at?: unknown };
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null;
    return { pid, at: typeof at === 'number' && Number.isFinite(at) ? at : null };
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
  // Never remove a lock another process took (ours was taken for left over).
  if (await readFile(lockPath, 'utf8').catch(() => null) === token) await rm(lockPath, { force: true });
}
