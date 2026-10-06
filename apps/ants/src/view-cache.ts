const DEFAULT_TTL_MS = 20_000;

/** Independent views load concurrently; the shared RPC provider paces chain requests.
 * Identical reads share one promise, and completed values expire or invalidate after actions.
 */
export class ViewCache {
  private readonly entries = new Map<string, { at: number; value: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private generation = 0;

  constructor(private readonly ttlMs = DEFAULT_TTL_MS) {}

  read<T>(key: string, load: () => Promise<T>, ttlMs = this.ttlMs, shouldCache: (value: T) => boolean = () => true): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const generation = this.generation;
    const task = Promise.resolve().then(load);
    this.inflight.set(key, task);
    // Settle in the first continuation so a caller awaiting `task` never sees a stale in-flight entry.
    const settle = () => { if (this.inflight.get(key) === task) this.inflight.delete(key); };
    task.then((value) => {
      if (generation === this.generation) {
        if (shouldCache(value)) this.entries.set(key, { at: Date.now(), value });
        else this.entries.delete(key);
      }
      settle();
    }, settle);
    return task;
  }

  /** Old reads may finish, but cannot populate the next wallet's cache. */
  invalidate(): void {
    this.generation++;
    this.inflight.clear();
    this.entries.clear();
  }
}
