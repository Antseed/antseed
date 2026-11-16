import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isOwnedProcessAlive, killOwned, processStartTime } from './lock.mjs';
import { readJson, saveJson } from './manifest.mjs';

// `pnpm testbench desktop` is a tree of about ten processes (pnpm, concurrently, Vite, Electron and its helpers) that
// outlives its launcher if the launcher dies. The launcher starts it as its own process group and records the leader;
// `down` and the stale cleanup then stop every member of that group they can prove the testbench started.
const recordsDir = (dir) => join(dir, 'desktops');
const STOP_GRACE_MS = 5000;
const SETTLE_MS = 5000;

/** Records a desktop process group (its leader's pid and start time) under the testbench dir. Returns the record. */
export async function recordAttachedDesktop(dir, { pid, home, instance }, deps = {}) {
  const record = { pid, startedAt: (deps.startTime ?? processStartTime)(pid), home, instance };
  await mkdir(recordsDir(dir), { recursive: true, mode: 0o700 });
  await saveJson(join(recordsDir(dir), `${pid}.json`), record);
  return record;
}

export async function forgetAttachedDesktop(dir, record) {
  await rm(join(recordsDir(dir), `${record.pid}.json`), { force: true });
}

/** The live pids in process group `pgid` (a zombie has exited and only waits to be reaped). */
export function processGroupMembers(pgid) {
  const result = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`);
  return result.stdout.split('\n').map((line) => line.trim().split(/\s+/))
    .filter(([pid, group, stat]) => Number(group) === pgid && Number(pid) > 0 && !stat?.startsWith('Z'))
    .map(([pid]) => Number(pid));
}

/** A process's environment as one string (variables separated by whitespace or NUL), or null if it cannot be read. */
export function processEnvironment(pid, platform = process.platform) {
  if (platform === 'linux') {
    try { return readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { return null; }
  }
  const result = spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

const hasVariable = (environment, assignment) => new RegExp(`(^|[\\s\\0])${assignment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s\\0])`).test(environment);

/** Proof a process belongs to this testbench's attached desktop: it runs with the testbench HOME and the attach-only flag. */
export function isAttachedDesktopProcess(environment, home) {
  return typeof environment === 'string' && hasVariable(environment, `HOME=${home}`) && hasVariable(environment, 'ANTSEED_DESKTOP_ATTACH_ONLY=1');
}

/**
 * Stops the members of a recorded desktop group that are provably this testbench's, each with killOwned, re-scanning
 * until the group is empty or the settle time is over (its parts start short-lived helpers while they shut down).
 * Returns { stopped, problems }: `problems` names what is still running. A group with no provable member whose leader
 * is gone is not ours (its id was reused, or the desktop is gone), so it is left alone and is not a problem.
 */
export async function stopAttachedDesktop(record, deps = {}) {
  const listGroup = deps.listGroup ?? processGroupMembers;
  const environmentOf = deps.environmentOf ?? processEnvironment;
  const startTime = deps.startTime ?? processStartTime;
  const kill = deps.kill ?? killOwned;
  const leaderAlive = deps.leaderAlive ?? isOwnedProcessAlive;
  const attempted = new Set();
  const stopProven = async () => {
    const fresh = listGroup(record.pid).filter((pid) => !attempted.has(pid) && isAttachedDesktopProcess(environmentOf(pid), record.home));
    for (const pid of fresh) attempted.add(pid);
    const entries = fresh.map((pid) => ({ pid, startedAt: startTime(pid) })).filter((entry) => entry.startedAt);
    await Promise.all(entries.map((entry) => kill(entry, { graceMs: deps.graceMs ?? STOP_GRACE_MS })));
  };
  await stopProven();
  if (attempted.size === 0 && !leaderAlive(record)) return { stopped: [], problems: [] };
  const deadline = Date.now() + (deps.settleMs ?? SETTLE_MS);
  while (listGroup(record.pid).length > 0 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    await stopProven();
  }
  const remaining = listGroup(record.pid);
  const problems = remaining.map((pid) => `pid ${pid} of desktop ${record.instance} is still running${attempted.has(pid) ? '' : ' (not provably the testbench\'s, so it was left alone)'}`);
  return { stopped: [...attempted].filter((pid) => !remaining.includes(pid)), problems };
}

/** Stops every recorded desktop of a testbench and forgets those fully stopped. Returns what could not be stopped. */
export async function stopAttachedDesktops(dir, { say = () => {}, deps = {} } = {}) {
  const names = await readdir(recordsDir(dir)).catch(() => []);
  const problems = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const record = await readJson(join(recordsDir(dir), name)).catch(() => null);
    if (!record) continue;
    const result = await stopAttachedDesktop(record, deps);
    if (result.stopped.length) say(`Stopped attached desktop ${record.instance} (${result.stopped.length} processes)`);
    problems.push(...result.problems);
    if (!result.problems.length) await forgetAttachedDesktop(dir, record);
  }
  return problems;
}
