import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
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

async function readLock(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { corrupt: true };
  }
}

/**
 * Exclusive lock file. Returns { state: 'acquired' }, { state: 'held', holder } for a live owner,
 * or recovers a stale lock (dead PID, reused PID, corrupt file) and acquires it.
 */
export async function acquireLock(path, info = {}, deps = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const entry = { ...(deps.entry ?? ownProcessEntry()), host: hostname(), createdAt: new Date().toISOString(), ...info };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(entry, null, 2)}\n`);
      await handle.close();
      return { state: 'acquired', entry, recoveredStale: attempt > 0 };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = await readLock(path);
    if (holder && !holder.corrupt && isOwnedProcessAlive(holder, deps)) return { state: 'held', holder };
    await rm(path, { force: true });
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
