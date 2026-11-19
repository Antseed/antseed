import {useEffect, useRef, type CSSProperties, type JSX, type RefObject} from 'react';
import {useInView} from '../../../../lib/useInView';
import {usePageVisible} from '../../../../lib/usePageVisible';
import {useSiteTheme} from '../../../../lib/useSiteTheme';
import {useStill} from '../../../../lib/useStill';
import {isDarkTheme} from '../../../../lib/theme';
import {ASSETS} from '../data';
import {Clouds} from './Clouds';
import {usePaintingArrival} from './usePaintingArrival';
import {useDayFilm} from './useDayFilm';
import {useNightLoop} from './useNightLoop';
import {useFireflies} from '../../../../lib/fireflies/useFireflies';
import {HERO_FLIES} from './heroFireflies';
import styles from './Painting.module.css';

/** How long the night's fade runs when the theme flips (the transition is in the CSS; this only scopes it to a flip, never a load). */
const THEME_FADE_MS = 2000;

const pictureOnScreen = () => (isDarkTheme() ? ASSETS.night : ASSETS.poster);

/** Marks `ref` with data-theming for a moment after each theme flip, so the night fades in or out instead of cutting. */
function useThemeFade(ref: RefObject<HTMLElement | null>, theme: string, still: boolean) {
  const first = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (first.current) { first.current = false; return; }
    if (!el || still) return;
    el.dataset.theming = '';
    const t = window.setTimeout(() => { delete el.dataset.theming; }, THEME_FADE_MS);
    return () => clearTimeout(t);
  }, [ref, theme, still]);
}

/** Once the page has loaded, both themes' stills are fetched into the cache (off screen), ready for a flip. */
function useWarmStills(): void {
  useEffect(() => {
    const warm = () => [ASSETS.poster, ASSETS.night].forEach((src) => { new Image().src = src; });
    if (document.readyState === 'complete') warm(); else window.addEventListener('load', warm, {once: true});
    return () => window.removeEventListener('load', warm);
  }, []);
}

const STILLS = {'--day': `url(${ASSETS.poster})`, '--night': `url(${ASSETS.night})`} as CSSProperties;

type Props = {paintRef: RefObject<HTMLDivElement | null>; nightRef: RefObject<HTMLDivElement | null>; dayFilmRef: RefObject<HTMLVideoElement | null>};

/** The meadow: the day's poster and film with clouds drifting over its sky, the night still and its loop over them, and fireflies. */
export function Painting({paintRef, nightRef, dayFilmRef}: Props): JSX.Element {
  const nightFilmRef = useRef<HTMLVideoElement>(null);
  const fliesRef = useRef<HTMLCanvasElement>(null);
  const theme = useSiteTheme();
  const night = theme === 'dark';
  const still = useStill();
  const onScreen = useInView(paintRef);
  const visible = usePageVisible();
  const live = onScreen && visible;

  const covered = usePaintingArrival(paintRef, styles.cover, pictureOnScreen);
  useThemeFade(paintRef, theme, still);
  useWarmStills();
  useDayFilm(dayFilmRef, {base: ASSETS.dayLoop, onClass: styles.on, playing: live && !night});
  useNightLoop(nightFilmRef, {src: ASSETS.nightLoop, onClass: styles.on, playing: live && night && !still});
  useFireflies(fliesRef, HERO_FLIES, {night, live, still});

  return (
    <div ref={paintRef} className={styles.paint} style={STILLS}>
      <div className={styles.stage}>
        <video ref={dayFilmRef} className={styles.film} muted loop playsInline preload="none" disablePictureInPicture disableRemotePlayback aria-hidden="true" />
        <Clouds paused={still || !live} />
      </div>
      <div ref={nightRef} className={styles.night}>
        <video ref={nightFilmRef} className={styles.nightFilm} muted loop playsInline preload="none" disablePictureInPicture disableRemotePlayback aria-hidden="true" />
        <canvas ref={fliesRef} className={styles.flies} aria-hidden="true" />
      </div>
      {covered && <div className={styles.veil} data-veil="" />}
    </div>
  );
}
