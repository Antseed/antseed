import type { SellerEvent } from '@antseed/node';

type EventInput = Omit<SellerEvent, 'at'>;

/**
 * A clean shutdown deletes daemon.state.json, so finding one at startup means the
 * previous run died (crash, OOM kill, SIGKILL). `previousState` is the file's text.
 */
export function uncleanExitEvent(previousState: string | null, now: number): EventInput | null {
  if (!previousState) return null;
  let updatedAt: number | undefined;
  try {
    updatedAt = (JSON.parse(previousState) as { updatedAt?: number }).updatedAt;
  } catch {
    // A file torn mid-write is still evidence of an unclean exit.
  }
  const ago = typeof updatedAt === 'number' ? ` (last seen ${Math.max(0, Math.round((now - updatedAt) / 60_000))} min ago)` : '';
  return { kind: 'crashed', severity: 'warning', title: `Seller restarted after an unexpected exit${ago}` };
}

export interface IdleWatchOptions {
  /** Off when unset or not positive. A function is re-read on every check, so edits apply live. */
  idleMinutes: number | undefined | (() => number | undefined);
  node: { on(event: 'session:updated', listener: () => void): unknown; off(event: 'session:updated', listener: () => void): unknown };
  record: (event: EventInput) => unknown;
  now?: () => number;
  checkEveryMs?: number;
}

/** Emits `idle` once no request has arrived for idleMinutes, and `active` when traffic returns. */
export function startIdleWatch(options: IdleWatchOptions): { stop(): void; check(): void } {
  const minutes = typeof options.idleMinutes === 'function' ? options.idleMinutes : () => options.idleMinutes as number | undefined;
  const now = options.now ?? Date.now;
  let lastActivity = now();
  let idle = false;
  const onActivity = () => {
    lastActivity = now();
    if (idle) {
      idle = false;
      options.record({ kind: 'active', severity: 'info', title: 'Requests are arriving again' });
    }
  };
  const check = () => {
    const idleMinutes = minutes() ?? 0;
    if (!(idleMinutes > 0) || idle || now() - lastActivity < idleMinutes * 60_000) return;
    idle = true;
    options.record({ kind: 'idle', severity: 'warning', title: `No requests for ${idleMinutes} minutes` });
  };
  options.node.on('session:updated', onActivity);
  const timer = setInterval(check, options.checkEveryMs ?? 60_000);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      options.node.off('session:updated', onActivity);
    },
    check,
  };
}
