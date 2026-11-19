/** Thrown into a run's pending tweens when a newer run replaces it. */
export const CANCELLED = Symbol('cancelled');

const MAX_FRAME_MS = 64;   // a dropped frame never jumps the animation more than this

export type Clock = {
  /** Resolves after `ms` of live time, calling `onFrame(progress 0..1)` each frame. Rejects with CANCELLED after `cancel()`. */
  tween(ms: number, onFrame?: (p: number) => void): Promise<void>;
  /** Cancels every pending tween (the run they belong to is over). */
  cancel(): void;
  /** Time passes only while live; pending tweens park while it is not and resume here, asking for no frames meanwhile. */
  setLive(live: boolean): void;
};

/** A pausable animation clock: time only counts while live (board on screen, tab visible). */
export function createClock(): Clock {
  let gen = 0;
  let live = false;
  const parked = new Set<FrameRequestCallback>();
  const resume = () => {
    const ticks = [...parked];
    parked.clear();
    ticks.forEach((tick) => requestAnimationFrame(tick));
  };

  return {
    tween(ms, onFrame) {
      const g = gen;
      return new Promise<void>((resolve, reject) => {
        let elapsed = 0;
        let last: number | null = null;
        const tick = (now: number) => {
          if (g !== gen) { reject(CANCELLED); return; }
          if (!live) { last = null; parked.add(tick); return; }
          if (last !== null) elapsed += Math.min(now - last, MAX_FRAME_MS);
          last = now;
          onFrame?.(Math.min(elapsed / ms, 1));
          if (elapsed >= ms) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    cancel() {
      gen++;
      resume();   // parked tweens wake once to see they are cancelled
    },
    setLive(next) {
      live = next;
      if (live) resume();
    },
  };
}
