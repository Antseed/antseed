import {useEffect, useState} from 'react';
import {epochAt, formatCountdown} from './selectors';
import {useAntsToken} from './useAntscan';

const EPOCH_TICK_MS = 60_000;

export type Epoch = {
  epoch: number;
  /** "Next epoch in 3d 4h 5m"; null on the server and the first client render, which can't know the time. */
  countdown: string | null;
};

/** The current epoch, and a countdown to the next that ticks each minute while `active` (on screen, tab visible). */
export function useEpoch(active: boolean): Epoch {
  const ants = useAntsToken();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!active) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), EPOCH_TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  if (now === null) return {epoch: ants.epoch, countdown: null};
  const clock = epochAt(ants, Math.floor(now / 1000));
  return {epoch: clock.epoch, countdown: clock.secondsLeft > 0 ? formatCountdown(clock.secondsLeft) : 'Awaiting the next epoch'};
}
