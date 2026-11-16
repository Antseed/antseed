/** Outcome of waiting for an ERC-20 allowance to cover an amount. */
export type AllowanceWaitOutcome = 'covered' | 'stale' | 'failed' | 'cancelled';

export interface WaitForAllowanceOptions {
  /** Reads the current allowance. Resolve `undefined` or throw when the read failed. */
  read: () => Promise<bigint | undefined>;
  /** Amount the allowance must cover. */
  required: bigint;
  /** Stops waiting (e.g. the component unmounted or the step changed). */
  isCancelled?: () => boolean;
  /** Total time to keep re-reading, in ms. */
  maxWaitMs?: number;
  /** Delay before the first retry, in ms; grows by `stepMs` per retry up to `maxDelayMs`. */
  initialDelayMs?: number;
  stepMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Re-reads an allowance until it covers `required`, with bounded retries and
 * backoff. After an approve() receipt confirms, the RPC node answering the
 * read can still be behind that block (or the read can fail), so a single
 * read is not enough to tell whether the approval landed.
 *
 * Resolves `covered` as soon as a read covers the amount, otherwise `stale`
 * (the last read succeeded but was too low) or `failed` (the last read failed)
 * once `maxWaitMs` of retries have passed.
 */
export async function waitForAllowance({
  read,
  required,
  isCancelled = () => false,
  maxWaitMs = 30_000,
  initialDelayMs = 1_000,
  stepMs = 500,
  maxDelayMs = 3_000,
  sleep = defaultSleep,
}: WaitForAllowanceOptions): Promise<AllowanceWaitOutcome> {
  let waited = 0;
  let delay = initialDelayMs;
  for (;;) {
    if (isCancelled()) return 'cancelled';
    let value: bigint | undefined;
    try {
      value = await read();
    } catch {
      value = undefined;
    }
    if (isCancelled()) return 'cancelled';
    if (value !== undefined && value >= required) return 'covered';
    if (waited >= maxWaitMs) return value === undefined ? 'failed' : 'stale';
    await sleep(delay);
    waited += delay;
    delay = Math.min(delay + stepMs, maxDelayMs);
  }
}
