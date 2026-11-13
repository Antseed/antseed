import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

/**
 * Start time of a PID as reported by ps (stable across the process lifetime), or null if gone.
 * Zombies count as gone: they have exited and only wait to be reaped (PID 1 in a container may never do it).
 */
export function processStartTime(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') return linuxStartTime(pid);
  const result = spawnSync('ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const match = result.status === 0 ? /^\s*(\S+)\s+(.+?)\s*$/.exec(result.stdout) : null;
  if (!match || match[1].startsWith('Z')) return null;
  return match[2];
}

/**
 * Linux: boot-relative start ticks from /proc (field 22). Unlike ps lstart, which is derived from the
 * current wall clock, this does not drift when the clock jumps (VM or laptop resume).
 */
function linuxStartTime(pid) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (fields[0] === 'Z' || fields[0] === 'X' || !fields[19]) return null;
  return `boot+${fields[19]}`;
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** True only if the PID is alive AND is still the process we recorded (guards against PID reuse). */
export function isOwnedProcessAlive(entry, deps = {}) {
  const alive = deps.isPidAlive ?? isPidAlive;
  const startTime = deps.processStartTime ?? processStartTime;
  if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0) return false;
  if (!alive(entry.pid)) return false;
  if (!entry.startedAt) return false;
  return startTime(entry.pid) === entry.startedAt;
}

export function ownProcessEntry(pid = process.pid) {
  return { pid, startedAt: processStartTime(pid) };
}

/** The lock file's text and parsed holder; `corrupt` when it does not parse, null when there is no lock. */
async function readLockText(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { text: null, holder: { corrupt: true } };
  }
  try {
    return { text, holder: JSON.parse(text) };
  } catch {
    return { text, holder: { corrupt: true } };
  }
}

async function readLock(path) {
  return (await readLockText(path))?.holder ?? null;
}

const uniqueSibling = (path, kind) => `${path}.${kind}-${process.pid}-${randomBytes(6).toString('hex')}`;

/**
 * A lock file that does not parse is only reclaimed once it is older than this: this module never publishes a partial
 * lock, but a starter from an older checkout (open + write) may be between its create and its write.
 */
export const CORRUPT_LOCK_GRACE_MS = 5000;

async function ageMs(path, now) {
  try { return now - (await stat(path)).mtimeMs; } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));

/** Filesystems without hard links cannot publish a lock atomically; there is deliberately no unsafe fallback. */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);

/** link(), with a clear error where the filesystem has no hard links. Resolves true when published, false if `to` exists. */
async function publish(from, to, deps = {}) {
  try {
    await (deps.link ?? link)(from, to);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    if (NO_HARD_LINKS.has(error.code)) {
      throw new Error(`Cannot lock ${to}: the testbench lock needs a filesystem with hard links (link() failed with ${error.code}). Put the testbench state on a local disk (set ANTSEED_TESTBENCH_HOME)`);
    }
    throw error;
  }
}

/** Writes `body` to a fresh unique sibling of `path` and tries to link it to `path`; the draft is always removed. */
async function publishFresh(path, body, deps = {}) {
  const draft = uniqueSibling(path, 'new');
  await writeFile(draft, body, { mode: 0o600, flag: 'wx' });
  try {
    return await publish(draft, path, deps);
  } finally {
    await rm(draft, { force: true });
  }
}

const MAX_RECLAIM_LEVELS = 16;

// A reclaimer that dies between removing the stale lock and publishing its own (or before its finally runs) leaves a
// `<lock>.reclaim-<hash>-<level>` file behind. It never blocks anything: it is keyed by that stale lock's exact text,
// which can never be at the lock path again, so no later reclaim looks for it. Nothing sweeps these files on purpose:
// a sweep cannot tell such a leftover from a live reclaimer's mutex or draft without a race. Delete them by hand once
// no testbench is starting, if they bother you.

/**
 * Takes the reclaim mutex for one stale lock. Mutexes are named after the stale lock's text, so the right to remove a
 * given stale lock is won exactly once, by link(). A mutex is only superseded when its owner is dead, by winning the
 * next level's mutex for the same stale text; a live reclaimer is never preempted, so at most one live process ever
 * acts on a given stale lock. Returns the mutex paths to remove when done, or null while a live reclaimer is busy.
 */
async function takeReclaimMutex(path, seen, body, deps) {
  const key = createHash('sha256').update(seen ?? '').digest('hex').slice(0, 16);
  const levels = [];
  for (let level = 0; level < MAX_RECLAIM_LEVELS; level += 1) {
    const mutex = `${path}.reclaim-${key}-${level}`;
    levels.push(mutex);
    if (await publishFresh(mutex, body, deps)) return levels;
    const owner = await readLockText(mutex);
    if (!owner) return null; // finished and cleaned up just now: start over
    if (!owner.holder.corrupt && isOwnedProcessAlive(owner.holder, deps)) return null;
  }
  throw new Error(`Could not take the reclaim mutex for ${path}: ${MAX_RECLAIM_LEVELS} dead reclaimers`);
}

/**
 * Removes a lock judged stale from its text `seen` and publishes ours, under the reclaim mutex for that text. While the
 * stale file exists nobody can link a lock into place, and while the mutex is held nobody else removes it, so a fresh
 * lock is never moved or removed. Returns true when ours is published, false when the caller should look again.
 */
async function reclaimStale(path, seen, body, deps) {
  const hook = deps.onReclaimStep ?? (async () => {});
  await hook('judged-stale');
  const mutex = await takeReclaimMutex(path, seen, body, deps);
  if (!mutex) return false;
  try {
    if ((await readLockText(path))?.text !== seen) return false;
    await hook('mutex-held');
    await rm(path, { force: true });
    // Another contender spinning on link() may take the now free path first; then it is the owner, fairly.
    return await publishFresh(path, body, deps);
  } finally {
    for (const level of mutex) await rm(level, { force: true });
  }
}

/**
 * Exclusive lock file. Returns { state: 'acquired' }, { state: 'held', holder } for a live owner,
 * or recovers a stale lock (dead PID, reused PID, corrupt file) and acquires it.
 * The lock is published atomically: a fully written unique file is hard-linked to `path`, which fails if a lock
 * exists, so no reader ever sees a partial lock and two contenders can never both create it. Needs a filesystem
 * with hard links.
 */
export async function acquireLock(path, info = {}, deps = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const entry = { ...(deps.entry ?? ownProcessEntry()), host: hostname(), createdAt: new Date().toISOString(), ...info };
  const body = `${JSON.stringify(entry, null, 2)}\n`;
  const graceMs = deps.corruptGraceMs ?? CORRUPT_LOCK_GRACE_MS;
  const now = deps.now ?? Date.now;
  let recoveredStale = false;
  // Bounded by time, so a fresh corrupt lock can outlive its grace before this gives up.
  const deadline = now() + graceMs + 10_000;
  while (now() <= deadline) {
    if (await publishFresh(path, body, deps)) return { state: 'acquired', entry, recoveredStale };
    const current = await readLockText(path);
    if (!current) {
      await jitter(1, 5);
      continue;
    }
    if (!current.holder.corrupt && isOwnedProcessAlive(current.holder, deps)) return { state: 'held', holder: current.holder };
    if (current.holder.corrupt) {
      const age = await ageMs(path, now());
      if (age !== null && age < graceMs) {
        await sleep(Math.min(100, graceMs));
        continue;
      }
    }
    recoveredStale = true;
    if (await reclaimStale(path, current.text, body, deps)) return { state: 'acquired', entry, recoveredStale };
    await jitter(1, 10);
  }
  throw new Error(`Could not acquire lock ${path}`);
}

export async function inspectLock(path, deps = {}) {
  const holder = await readLock(path);
  if (!holder) return { state: 'free' };
  if (!holder.corrupt && isOwnedProcessAlive(holder, deps)) return { state: 'held', holder };
  return { state: 'stale', holder };
}

/** Removes the lock only when it belongs to the given entry. */
export async function releaseLock(path, entry) {
  const holder = await readLock(path);
  if (holder && !holder.corrupt && holder.pid === entry.pid && holder.startedAt === entry.startedAt) {
    await rm(path, { force: true });
    return true;
  }
  return false;
}

export async function withLock(path, body, { timeoutMs = 60_000, deps = {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await acquireLock(path, {}, deps);
    if (result.state === 'acquired') {
      try {
        return await body();
      } finally {
        await releaseLock(path, result.entry);
      }
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${path} (held by pid ${result.holder.pid})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Signals a recorded process only if it is still the same process we started. */
export async function killOwned(entry, { graceMs = 10_000, deps = {} } = {}) {
  if (!isOwnedProcessAlive(entry, deps)) return 'not-running';
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  try { kill(entry.pid, 'SIGTERM'); } catch { return 'not-running'; }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(deps.isPidAlive ?? isPidAlive)(entry.pid)) return 'terminated';
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isOwnedProcessAlive(entry, deps)) {
    try { kill(entry.pid, 'SIGKILL'); } catch { /* already gone */ }
    return 'killed';
  }
  return 'terminated';
}
