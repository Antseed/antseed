import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import styles from './HomeField.module.scss';

type FieldMode = 'day' | 'night';

const asset = {
  day: {
    still: new URL('../../../assets/v4/field/field-day.jpg', import.meta.url).href,
    loop: new URL('../../../assets/v4/field/field2-day-loop.mp4', import.meta.url).href,
    loopPoster: new URL('../../../assets/v4/field/field2-day-loop.jpg', import.meta.url).href,
    clip: new URL('../../../assets/v4/field/field2-to-day.mp4', import.meta.url).href,
    clipPoster: new URL('../../../assets/v4/field/field2-to-day.jpg', import.meta.url).href,
  },
  night: {
    still: new URL('../../../assets/v4/field/field-private.jpg', import.meta.url).href,
    loop: new URL('../../../assets/v4/field/field2-private-loop.mp4', import.meta.url).href,
    loopPoster: new URL('../../../assets/v4/field/field2-private-loop.jpg', import.meta.url).href,
    clip: new URL('../../../assets/v4/field/field2-to-private.mp4', import.meta.url).href,
    clipPoster: new URL('../../../assets/v4/field/field2-to-private.jpg', import.meta.url).href,
  },
} as const;

const MODES: FieldMode[] = ['day', 'night'];

/** Skip the clip and crossfade the loops if it hasn't started by then. */
const CLIP_START_TIMEOUT_MS = 900;
/** Longest a clip may hold the old loop if `ended` never fires. */
const CLIP_MAX_MS = 7000;
const CLIP_FADE_DELAY_MS = 140;
const CLIP_RESET_DELAY_MS = 800;
const PREVIOUS_CLIP_HIDE_MS = 600;
/** The clips open almost still for a second, so they run faster than painted. */
const CLIP_PLAYBACK_RATE = 1.6;

/**
 * The home's living field. `night` is undefined until the privacy mode has
 * loaded, so opening the app in Private never plays the sunset.
 */
export function HomeField({ night }: { night: boolean | undefined }) {
  if (night === undefined) return null;
  return <FieldLayers night={night} />;
}

function FieldLayers({ night }: { night: boolean }) {
  const target: FieldMode = night ? 'night' : 'day';
  const reducedMotion = usePrefersReducedMotion();
  const [loopMode, setLoopMode] = useState<FieldMode>(target);
  const [crossfade, setCrossfade] = useState(false);
  const [clipShown, setClipShown] = useState<Record<FieldMode, boolean>>({ day: false, night: false });
  const clips = useRef<Partial<Record<FieldMode, HTMLVideoElement | null>>>({});
  const loops = useRef<Partial<Record<FieldMode, HTMLVideoElement | null>>>({});
  const previousTarget = useRef(target);
  const playingClip = useRef<FieldMode | null>(null);
  const run = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => () => {
    run.current += 1;
    timers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  // Reduced motion turned on mid-clip: end the transition at once and show
  // the current mode's still, so neither the old still nor the old clip returns.
  useEffect(() => {
    if (!reducedMotion) return;
    run.current += 1;
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    playingClip.current = null;
    setClipShown({ day: false, night: false });
    setCrossfade(true);
    setLoopMode(target);
  }, [reducedMotion, target]);

  useEffect(() => {
    const previous = previousTarget.current;
    if (previous === target) return;
    previousTarget.current = target;
    // Reduced motion: the effect above has already shown the new still.
    if (reducedMotion) return;

    // A newer transition makes every pending one obsolete.
    run.current += 1;
    const thisRun = run.current;

    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    const later = (fn: () => void, ms: number) => {
      timers.current.push(window.setTimeout(() => { if (run.current === thisRun) fn(); }, ms));
    };

    const clip = clips.current[target];
    const otherClip = clips.current[previous];
    if (otherClip) otherClip.onended = null;
    let started = false;
    let aborted = false;
    let finished = false;

    const abort = () => {
      // A late play() rejection from a run that a reverse switch replaced must
      // not reset the field to that run's target.
      if (started || run.current !== thisRun) return;
      aborted = true;
      if (clip) {
        clip.pause();
        clip.currentTime = 0;
      }
      playingClip.current = null;
      setCrossfade(true);
      setLoopMode(target);
      setClipShown({ day: false, night: false });
    };
    if (!clip || clip.readyState < 2) {
      abort();
      return;
    }

    // Switched back mid-clip: the two clips are exact reverses, so pick up
    // from the mirrored point and keep the first visible until this one plays.
    const mirrored = playingClip.current === previous && otherClip?.duration
      ? Math.max(0, otherClip.duration - otherClip.currentTime)
      : 0;
    clip.currentTime = mirrored;
    clip.playbackRate = CLIP_PLAYBACK_RATE;

    const finish = () => {
      if (finished || aborted || run.current !== thisRun) return;
      finished = true;
      const loop = loops.current[target];
      if (loop) {
        loop.currentTime = 0;
        void loop.play().catch(() => {});
      }
      setCrossfade(false);
      setLoopMode(target);
      later(() => setClipShown((shown) => ({ ...shown, [target]: false })), CLIP_FADE_DELAY_MS);
      later(() => {
        clip.pause();
        clip.currentTime = 0;
        playingClip.current = null;
      }, CLIP_RESET_DELAY_MS);
    };
    clip.onended = finish;

    void clip.play().then(() => {
      if (aborted || run.current !== thisRun) return;
      started = true;
      playingClip.current = target;
      setClipShown((shown) => ({ ...shown, [target]: true }));
      later(() => {
        setClipShown((shown) => ({ ...shown, [previous]: false }));
        if (otherClip) {
          otherClip.pause();
          otherClip.currentTime = 0;
        }
      }, PREVIOUS_CLIP_HIDE_MS);
    }, abort);
    later(abort, CLIP_START_TIMEOUT_MS);
    later(finish, CLIP_MAX_MS);
  }, [target, reducedMotion]);

  const layerClass = (mode: FieldMode) =>
    `${styles.layer}${crossfade || reducedMotion ? ` ${styles.crossfade}` : ''}${loopMode === mode ? '' : ` ${styles.hidden}`}`;

  return (
    <div className={styles.field} aria-hidden="true" data-glide-field>
      {MODES.map((mode) => (reducedMotion
        ? <img key={mode} src={asset[mode].still} alt="" className={layerClass(mode)} />
        : (
          <video
            key={mode}
            ref={(element) => { loops.current[mode] = element; }}
            src={asset[mode].loop}
            poster={asset[mode].loopPoster}
            className={layerClass(mode)}
            autoPlay
            muted
            loop
            playsInline
          />
        )))}
      {!reducedMotion && MODES.map((mode) => (
        <video
          key={mode}
          ref={(element) => { clips.current[mode] = element; }}
          src={asset[mode].clip}
          poster={asset[mode].clipPoster}
          className={`${styles.layer} ${styles.clip}${clipShown[mode] ? ` ${styles.clipShown}` : ''}`}
          preload="auto"
          muted
          playsInline
        />
      ))}
      <div className={`${styles.scrim} ${night ? styles.scrimNight : styles.scrimDay}`} />
    </div>
  );
}
