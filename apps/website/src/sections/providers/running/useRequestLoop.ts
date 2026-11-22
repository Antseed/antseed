import type {RefObject} from 'react';
import {useInView} from '../../../lib/useInView';
import {usePageVisible} from '../../../lib/usePageVisible';
import {useStill} from '../../../lib/useStill';
import {useInterval} from '../../../lib/useInterval';
import {replayAnimation} from '../../../lib/replayAnimation';

const EVERY_MS = 5500;
const JITTER = 0.2;
const FIRST_SHARE = 0.6;

type Plays = {
  /** Plays the request's status from serving to served. */
  serve: string;
  /** Plays the next request taking the window's place. */
  again: string;
};

/** While the scene is on screen, the tab visible and motion allowed: about every 5.5s the next request comes in and is served. */
export function useRequestLoop(scene: RefObject<HTMLElement | null>, win: RefObject<HTMLElement | null>, status: RefObject<HTMLElement | null>, plays: Plays): void {
  const onScreen = useInView(scene);
  const visible = usePageVisible();
  const still = useStill();
  useInterval(() => {
    replayAnimation(win.current, plays.again);
    replayAnimation(status.current, plays.serve);
  }, EVERY_MS, onScreen && visible && !still, {jitter: JITTER, firstShare: FIRST_SHARE});
}
