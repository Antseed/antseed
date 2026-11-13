/**
 * A value read in the background: callers get the last value read (or null)
 * at once and never wait on the read itself. A read starts when one is asked
 * for and none is running, until a value counts as final. `clear()` forgets
 * the value and ignores any read still running from before.
 */
export class BackgroundRead<T> {
  private value: T | null = null;
  private running: Promise<void> | null = null;
  private generation = 0;

  constructor(
    private readonly load: () => Promise<T | null>,
    private readonly isFinal: (value: T) => boolean = () => true,
  ) {}

  current(): T | null {
    if (!this.running && !(this.value !== null && this.isFinal(this.value))) this.start();
    return this.value;
  }

  clear(): void {
    this.value = null;
    this.generation += 1;
  }

  /** Settles when the read started by the last `current()` is done; for tests. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private start(): void {
    const generation = this.generation;
    this.running = this.load()
      .then((value) => {
        if (generation === this.generation && value !== null) this.value = value;
      }, () => undefined)
      .finally(() => { this.running = null; });
  }
}
