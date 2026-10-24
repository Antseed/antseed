import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

export const DEFAULT_SLOT = 'default';
const SLOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,15}$/;

export function worktreeRoot(cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('pnpm sandbox must run inside a git worktree');
  return realpathSync(result.stdout.trim());
}

export function sanitizeSegment(value) {
  const clean = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return clean || 'worktree';
}

export function validateSlot(slot = DEFAULT_SLOT) {
  if (!SLOT_PATTERN.test(slot)) throw new Error(`Invalid sandbox slot "${slot}" (use 1-16 chars: a-z, 0-9, -)`);
  return slot;
}

export function sandboxName(worktreePath, slot = DEFAULT_SLOT) {
  validateSlot(slot);
  const hash = createHash('sha1').update(resolve(worktreePath)).digest('hex').slice(0, 8);
  const name = `wt-${sanitizeSegment(basename(worktreePath))}-${hash}`;
  return slot === DEFAULT_SLOT ? name : `${name}-${slot}`;
}

function isInside(child, parent) {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

export function sandboxRoot(env = process.env, home = homedir()) {
  const root = resolve(env.ANTSEED_SANDBOX_HOME?.trim() || join(home, '.antseed-sandbox'));
  if (isInside(root, join(home, '.antseed'))) throw new Error('Sandbox state must never live inside ~/.antseed');
  if (root === resolve(home)) throw new Error('Sandbox root must not be the home directory itself');
  return root;
}

export function sandboxPaths(root, name) {
  const dir = join(root, name);
  return {
    root,
    name,
    dir,
    home: join(dir, 'home'),
    anvilHome: join(dir, 'anvil-home'),
    buyer: join(dir, 'buyer'),
    sellers: join(dir, 'sellers'),
    seller: (id) => join(dir, 'sellers', id),
    config: join(dir, 'config'),
    logs: join(dir, 'logs'),
    reports: join(dir, 'reports'),
    manifest: join(dir, 'manifest.json'),
    lock: join(dir, 'sandbox.lock'),
    control: join(dir, 'control.json'),
  };
}

export { isInside };

const KEEP_ACROSS_RUNS = new Set(['identity.key']);

/**
 * Each `up` forks a fresh chain, so channel/metering/payment databases from a previous run describe
 * state that no longer exists. Removes everything under buyer/, sellers/<id>/ and home/ except
 * identity keys (stable peer IDs across runs). Returns the removed paths.
 */
export async function resetRunState(paths) {
  const removed = [];
  const clear = async (dir) => {
    let entries;
    try { entries = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (KEEP_ACROSS_RUNS.has(entry)) continue;
      const target = join(dir, entry);
      if (!isInside(target, paths.dir) || target === paths.dir) throw new Error(`Refusing to remove ${target}`);
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    }
  };
  await clear(paths.buyer);
  let sellers = [];
  try { sellers = await readdir(paths.sellers); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const id of sellers) await clear(join(paths.sellers, id));
  await rm(paths.home, { recursive: true, force: true });
  return removed;
}
