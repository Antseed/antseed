import {useEffect, useRef} from 'react';

type Options = {
  /** Each wait varies by up to this share either way, so loops on one page drift apart. */
  jitter?: number;
  /** The first run comes after this share of `ms`. */
  firstShare?: number;
};

/**
 * Calls `fn` about every `ms` while `active` (pass `inView && visible && !still`); stopped, not paused, otherwise, so it restarts
 * with a fresh first delay.
 */
export function useInterval(fn: () => void, ms: number, active: boolean, {jitter = 0, firstShare = 1}: Options = {}): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!active) return;
    let t: ReturnType<typeof setTimeout>;
    const next = (share: number) => { t = setTimeout(tick, ms * share * (1 - jitter + Math.random() * 2 * jitter)); };
    const tick = () => { latest.current(); next(1); };
    next(firstShare);
    return () => clearTimeout(t);
  }, [ms, active, jitter, firstShare]);
}
