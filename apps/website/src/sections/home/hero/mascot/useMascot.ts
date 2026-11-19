import {useEffect, useRef, type RefObject} from 'react';
import type {Hand} from '../seed/hand';
import type {MascotScene, SceneClasses, SceneEls} from './MascotScene';

/** No mascot on a phone: the card is as tall as its text there. */
const WIDE = '(min-width: 761px)';

type Refs = {[K in keyof Omit<SceneEls, 'seedImage' | 'film'>]: RefObject<HTMLElement | null>} & {film: RefObject<HTMLVideoElement | null>};

type Options = {refs: Refs; hand: Hand; classes: SceneClasses; active: boolean; still: boolean};

/**
 * The mascot, loaded as its own chunk once the page has loaded and only on a screen wide enough to show it, so it never weighs on
 * the first paint or on hydration. It draws only while `active` (on screen, tab visible).
 */
export function useMascot({refs, hand, classes, active, still}: Options): void {
  const scene = useRef<MascotScene | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const wide = window.matchMedia(WIDE);
    let dead = false;
    const start = () => {
      if (dead || scene.current || !wide.matches) return;
      import('./MascotScene').then(({MascotScene}) => {
        const r = refs;
        const cursor = r.cursor.current;
        if (dead || scene.current || !r.card.current || !cursor) return;
        const el = <T extends HTMLElement>(ref: RefObject<HTMLElement | null>) => ref.current as T;
        scene.current = new MascotScene({
          card: el(r.card), puppet: el<HTMLCanvasElement>(r.puppet), fore: el<HTMLCanvasElement>(r.fore), groundSeed: el(r.groundSeed),
          cursor, install: el(r.install), paint: el(r.paint), night: el(r.night), film: r.film.current,
          seedImage: () => cursor.querySelector('img'),
        }, hand, classes, still);
        scene.current.setActive(activeRef.current);
      });
    };
    const onLoad = () => start();
    if (document.readyState === 'complete') start(); else window.addEventListener('load', onLoad, {once: true});
    wide.addEventListener('change', start);
    return () => {
      dead = true;
      window.removeEventListener('load', onLoad);
      wide.removeEventListener('change', start);
      scene.current?.dispose();
      scene.current = null;
    };
  }, [refs, hand, classes, still]);

  useEffect(() => { scene.current?.setActive(active); }, [active]);
}
