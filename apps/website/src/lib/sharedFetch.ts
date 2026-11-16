/** A fetch shared by every mounted subscriber: the first call starts it, later
    calls join the same promise, and it is aborted only when the last
    subscriber leaves mid-flight. Resolves to null on failure or abort. */
export interface SharedFetch<T> {
  promise: Promise<T | null>;
  unsubscribe: () => void;
}

interface Inflight<T> {
  promise: Promise<T | null>;
  controller: AbortController;
  subscribers: number;
}

export function createSharedFetch<T>(
  run: (signal: AbortSignal) => Promise<T | null>,
  timeoutMs?: number,
): () => SharedFetch<T> {
  let inflight: Inflight<T> | null = null;

  return () => {
    if (!inflight) {
      const controller = new AbortController();
      const timeout = timeoutMs === undefined ? null : setTimeout(() => controller.abort(), timeoutMs);
      const entry: Inflight<T> = {
        controller,
        subscribers: 0,
        promise: run(controller.signal)
          .catch(() => null)
          .finally(() => {
            if (timeout !== null) clearTimeout(timeout);
            if (inflight === entry) inflight = null;
          }),
      };
      inflight = entry;
    }
    const entry = inflight;
    entry.subscribers += 1;
    return {
      promise: entry.promise,
      unsubscribe: () => {
        entry.subscribers -= 1;
        if (entry.subscribers === 0 && inflight === entry) {
          entry.controller.abort();
          inflight = null;
        }
      },
    };
  };
}
