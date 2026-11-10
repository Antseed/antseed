import { acquireLock, killOwned, releaseLock } from './lock.mjs';
import { readJson, saveJson } from './manifest.mjs';

const sameProcess = (a, b) => (a?.pid ?? null) === (b?.pid ?? null) && (a?.startedAt ?? null) === (b?.startedAt ?? null);

/**
 * Cleans up a testbench whose supervisor is gone (or was just forced down): stops the processes `manifest` records
 * (each only if it is still the process recorded), then resets control.json and manifest.json as the slot's lock
 * owner. Holding the lock is what makes the reset safe: a replacement supervisor cannot start while this runs, and one
 * that started first keeps its lock, control token and manifest, since a live owner makes acquireLock report `held`.
 * The reset also only happens while the manifest is still the generation that was judged stale. Returns
 * `{ results, slot }`: the per-process results (plus a `lock:` or `manifest:` note when it left metadata alone), and
 * `slot` 'reset' when it reset the metadata, 'held' when a live owner holds the slot, 'foreign-manifest' when another
 * generation wrote the manifest since.
 */
export async function cleanupStale(paths, manifest, deps = {}) {
  const kill = deps.killOwned ?? killOwned;
  const nodes = [...(manifest?.sellers ?? []).map((seller) => seller.process), ...Object.values(manifest?.nodeProcesses ?? {})].filter(Boolean);
  const entries = [manifest?.supervisor, manifest?.anvil, ...new Map(nodes.map((entry) => [entry.pid, entry])).values()].filter(Boolean);
  const results = [];
  for (const entry of entries) results.push(`${entry.pid}:${await kill(entry, { graceMs: entry === manifest?.anvil ? 30_000 : 10_000 })}`);
  // Reclaims the stale lock through the reclaim mutex, or reports the live owner that holds the slot now.
  const slot = await acquireLock(paths.lock, { role: 'stale-cleanup' }, deps.lockDeps ?? {});
  if (slot.state !== 'acquired') {
    results.push(`lock:held by pid ${slot.holder.pid}; its control and manifest were left alone`);
    return { results, slot: 'held' };
  }
  try {
    const current = await readJson(paths.manifest).catch(() => null);
    if (current && manifest && !sameProcess(current.supervisor, manifest.supervisor)) {
      results.push(`manifest:another supervisor (pid ${current.supervisor?.pid ?? 'unknown'}) wrote it since; left alone`);
      return { results, slot: 'foreign-manifest' };
    }
    await saveJson(paths.control, {}).catch(() => {});
    if (current) await saveJson(paths.manifest, { ...current, running: false, staleCleanedAt: new Date().toISOString() });
    return { results, slot: 'reset' };
  } finally {
    await releaseLock(paths.lock, slot.entry);
  }
}

/**
 * What `up` does with its slot, from `state` (runningState): reattach to a running testbench, wait while one is
 * starting or stopping, or start fresh, cleaning up stale state first. When the cleanup finds the slot taken (a
 * replacement got the lock, or wrote a newer manifest), it looks again instead of letting `up` spawn a supervisor
 * that could not get the lock. Returns { action: 'reattach' | 'wait' | 'start', state, reason? }.
 */
export async function settleSlot({ state, readState, cleanup, say = () => {}, attempts = 3 }) {
  let current = state;
  for (let attempt = 1; ; attempt += 1) {
    if (current.running) return { action: 'reattach', state: current };
    if (current.lock.state === 'held') return { action: 'wait', state: current };
    if (!(current.lock.state === 'stale' || current.manifest?.running || current.manifest?.starting)) return { action: 'start', state: current };
    const cleaned = await cleanup(current.manifest);
    say(`Cleaning up stale testbench state: ${cleaned.results.join(', ') || 'nothing running'}`);
    if (cleaned.slot === 'reset') return { action: 'start', state: current };
    if (attempt >= attempts) return { action: 'wait', state: current, reason: cleaned.results.at(-1) };
    current = await readState();
  }
}
