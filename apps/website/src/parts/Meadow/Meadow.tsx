import {useCallback, useEffect, useMemo, useRef, useState, type JSX, type RefObject} from 'react';
import clsx from 'clsx';
import {useInView} from '../../lib/useInView';
import {usePageVisible} from '../../lib/usePageVisible';
import {useSiteTheme} from '../../lib/useSiteTheme';
import {useStill} from '../../lib/useStill';
import AntEyes, {type EyeSet} from './AntEyes';
import {ANTS, loadEyeKit, type EyeKit, type Phase} from './eyeKit';
import {useEyeTracking} from './useEyeTracking';
import {useFinePointer} from '../../lib/useFinePointer';
import {useFireflies} from '../../lib/fireflies/useFireflies';
import {MEADOW_FLIES} from './meadowFireflies';
import {useMeadowFilms} from './useMeadowFilms';
import {useThemeFlip} from './useThemeFlip';
import styles from './Meadow.module.css';

const STILL_BASE = '/site/assets/home/footer/meadow-loop-';
const FILM_MARGIN = '200px 0px';
const EYES_MARGIN = '400px 0px';

function MeadowFilm({filmRef, className}: {filmRef: RefObject<HTMLVideoElement | null>; className?: string}): JSX.Element {
  const [ready, setReady] = useState(false);
  return (
    <video ref={filmRef} className={clsx(styles.film, ready && styles.filmReady, className)} muted loop playsInline preload="none"
      disablePictureInPicture disableRemotePlayback onLoadedData={() => setReady(true)} />
  );
}

/** The kit for the ants' eyes, fetched once the footer nears, only on devices with a mouse and with motion allowed. */
function useEyeKit(wanted: boolean): EyeKit | null {
  const [kit, setKit] = useState<EyeKit | null>(null);
  useEffect(() => {
    if (!wanted || kit) return;
    let live = true;
    loadEyeKit().then((k) => { if (live) setKit(k); }, () => {});
    return () => { live = false; };
  }, [wanted, kit]);
  return kit;
}

/**
 * The painted meadow under the footer, by day or by night: a still, its 6 s film over it once it plays, the night's fireflies and the
 * awake ants' eyes following the mouse. The night layer is revealed through a radial mask centred on the sun.
 */
export default function Meadow(): JSX.Element {
  const scene = useRef<HTMLDivElement>(null);
  const dayFilm = useRef<HTMLVideoElement>(null);
  const nightFilm = useRef<HTMLVideoElement>(null);
  const flies = useRef<HTMLCanvasElement>(null);
  const eyeSets = useRef<Partial<Record<Phase, EyeSet>>>({});
  const films = useMemo(() => ({day: dayFilm, night: nightFilm}), []);

  const phase: Phase = useSiteTheme() === 'dark' ? 'night' : 'day';
  const still = useStill();
  const visible = usePageVisible();
  const fine = useFinePointer();
  const nearFilm = useInView(scene, {rootMargin: FILM_MARGIN});
  const nearEyes = useInView(scene, {rootMargin: EYES_MARGIN, once: true});
  const seen = useInView(scene);
  const flipping = useThemeFlip(phase);

  const eyesOn = fine && !still;
  const kit = useEyeKit(eyesOn && nearEyes);
  const onEyesReady = useCallback((p: Phase, set: EyeSet | null) => {
    if (set) eyeSets.current[p] = set; else delete eyeSets.current[p];
  }, []);

  useMeadowFilms(films, phase, nearFilm && visible && !still);
  useFireflies(flies, MEADOW_FLIES, {night: phase === 'night', live: seen && visible, still});
  useEyeTracking(eyeSets, films, kit, ANTS.length, eyesOn && !!kit && seen && visible);

  const eyes = (p: Phase, className?: string) => kit && eyesOn ? <AntEyes kit={kit} phase={p} className={className} onReady={onEyesReady} /> : null;

  return (
    <div ref={scene} className={clsx(styles.scene, flipping && styles.flipping)} aria-hidden="true">
      <img className={styles.still} src={`${STILL_BASE}day-poster.webp`} width={1920} height={1080} alt="" loading="lazy" decoding="async" />
      <MeadowFilm filmRef={dayFilm} className={styles.overlay} />
      {eyes('day')}
      <img className={clsx(styles.still, styles.night)} src={`${STILL_BASE}night-poster.webp`} width={1920} height={1080} alt="" loading="lazy" decoding="async" />
      <MeadowFilm filmRef={nightFilm} className={styles.night} />
      {eyes('night', styles.night)}
      <canvas ref={flies} className={styles.fireflies} />
    </div>
  );
}
