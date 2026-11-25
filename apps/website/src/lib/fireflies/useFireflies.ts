import {useEffect, useRef, type RefObject} from 'react';
import type {Fireflies, FlyPlace} from './engine';

type State = {night: boolean; live: boolean; still: boolean};

/** Fireflies over a painting on `ref`'s canvas, placed by `place`. The engine is loaded the first time it is night; the flies move only
 *  while `live` (on screen, tab visible) and it is night, and are drawn once at rest when `still`. */
export function useFireflies(ref: RefObject<HTMLCanvasElement | null>, place: FlyPlace, {night, live, still}: State): void {
  const flies = useRef<Fireflies | null>(null);
  const state = useRef({live, still});
  state.current = {live: live && night, still};

  useEffect(() => {
    const cv = ref.current;
    if (!night || flies.current || !cv) return;
    let dead = false;
    import('./engine').then(({mountFireflies}) => {
      if (dead) return;
      flies.current = mountFireflies(cv, place);
      flies.current.set(state.current);
    });
    return () => { dead = true; };
  }, [ref, place, night]);

  useEffect(() => { flies.current?.set({live: live && night, still}); }, [live, night, still]);
  useEffect(() => () => { flies.current?.stop(); flies.current = null; }, []);
}
