/**
 * Starts the gateway unless something has called it off: the app began
 * quitting, or a stop (such as a switch to a remote gateway) overtook this
 * start. Starting takes several awaits, so either can happen during any of
 * them: it is checked before the spawn, and a process that came up anyway
 * is stopped rather than left behind. `cancelled` answers why, or null.
 */
export async function startUnlessCancelled(
  cancelled: () => string | null,
  start: () => Promise<unknown>,
  stop: () => Promise<unknown>,
): Promise<void> {
  const before = cancelled();
  if (before) throw new Error(before);
  await start();
  const after = cancelled();
  if (after) {
    await stop();
    throw new Error(after);
  }
}

export const CLOSING_ERROR = 'Antseed Desktop is closing';
export const START_CANCELLED_ERROR = 'The local gateway start was cancelled: the gateway was stopped or switched';

/** Starts the gateway unless the app has begun quitting; see `startUnlessCancelled`. */
export async function startUnlessClosing(
  isClosing: () => boolean,
  start: () => Promise<unknown>,
  stop: () => Promise<unknown>,
): Promise<void> {
  await startUnlessCancelled(() => (isClosing() ? CLOSING_ERROR : null), start, stop);
}

/**
 * Local gateway lifecycles: a start belongs to the generation it began in,
 * and a stop ends that generation, so a start still preparing when the user
 * switches to a remote gateway can't launch the local one afterwards. A
 * later explicit start begins a new generation and runs normally.
 */
export class StartGenerations {
  private generation = 0;

  begin(): number {
    return this.generation;
  }

  /** Called by a stop: every start begun before it is overtaken. */
  end(): void {
    this.generation += 1;
  }

  overtaken(started: number): boolean {
    return started !== this.generation;
  }
}
