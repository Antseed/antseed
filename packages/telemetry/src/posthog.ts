/**
 * Bounded PostHog transport. Captures queue in memory and leave in batches
 * (`/batch/`), with a short timeout and no retries. Every failure is
 * swallowed: telemetry never affects a request, startup or shutdown.
 */

export const POSTHOG_CAPTURE_TIMEOUT_MS = 4_000;

export type PostHogEvent = {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
};

export type PostHogSender = (events: PostHogEvent[]) => Promise<void>;

export function createPostHogSender(options: { host: string; projectApiKey: string; timeoutMs?: number }): PostHogSender {
  const batchUrl = `${options.host.replace(/\/+$/, '')}/batch/`;
  const timeoutMs = options.timeoutMs ?? POSTHOG_CAPTURE_TIMEOUT_MS;
  return async (events) => {
    if (events.length === 0) return;
    try {
      await fetch(batchUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: options.projectApiKey, batch: events }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // PostHog outages, offline machines, DNS failures: all ignored.
    }
  };
}

export type BatchQueueOptions = {
  send: PostHogSender;
  /** Oldest events are dropped beyond this. */
  maxQueue?: number;
  maxBatch?: number;
  flushIntervalMs?: number;
  /** Checked before each batch is sent; when false the rest of the queue is dropped unsent. */
  isEnabled?: () => boolean;
};

export class BatchQueue {
  private readonly queue: PostHogEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly maxQueue: number;
  private readonly maxBatch: number;
  private readonly flushIntervalMs: number;

  constructor(private readonly options: BatchQueueOptions) {
    this.maxQueue = options.maxQueue ?? 1_000;
    this.maxBatch = options.maxBatch ?? 100;
    this.flushIntervalMs = options.flushIntervalMs ?? 2_000;
  }

  get size(): number {
    return this.queue.length;
  }

  push(event: PostHogEvent): void {
    this.queue.push(event);
    if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Sends everything queued. Safe to call concurrently; never rejects. */
  async flush(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    while (this.queue.length > 0) {
      // Before every batch: an opt-out while an earlier batch was sending stops the rest.
      if (this.options.isEnabled && !this.options.isEnabled()) {
        this.queue.length = 0;
        return;
      }
      const batch = this.queue.splice(0, this.maxBatch);
      this.inFlight = this.options.send(batch).catch(() => undefined);
      await this.inFlight;
      this.inFlight = null;
    }
  }

  /** Flushes, waiting at most `timeoutMs`. */
  async close(timeoutMs = 750): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    let timeout: NodeJS.Timeout | null = null;
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }
}
