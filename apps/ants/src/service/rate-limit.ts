/**
 * Token bucket: `take(n)` resolves once `n` tokens are available, refilling
 * `perSecond` tokens up to `burst`. Callers are served in arrival order so a
 * large request cannot starve behind a stream of small ones.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly perSecond: number, private readonly burst: number, private readonly now: () => number = Date.now) {
    this.tokens = burst;
    this.lastRefill = now();
  }

  take(count = 1): Promise<void> {
    const turn = this.queue.then(() => this.wait(Math.min(count, this.burst)));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async wait(count: number): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }
      const deficit = count - this.tokens;
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(deficit / this.perSecond * 1000)));
    }
  }

  private refill(): void {
    const at = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (at - this.lastRefill) / 1000 * this.perSecond);
    this.lastRefill = at;
  }
}
