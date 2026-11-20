import {useEffect, useRef, useState, type JSX} from 'react';
import clsx from 'clsx';
import {PUPILS, SCENES, filmBase, pupilTransform, stallArt, type SceneName, type SetName} from './scenes';
import styles from './ProviderFilm.module.css';

type Props = {
  scene: SceneName;
  set: SetName;
  /** Fetch the film and its layers (once true, stays loaded). */
  load: boolean;
  /** Play now (this set's theme is showing, the panel on screen). */
  play: boolean;
};

// Safari (and every iOS browser) gets the MP4: it may claim WebM support and then never load it
const extension = (v: HTMLVideoElement) => {
  const ua = navigator.userAgent;
  const webkit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Android|Edg/.test(ua);
  return !webkit && v.canPlayType('video/webm; codecs="vp9"') ? 'webm' : 'mp4';
};

/** One theme's moving layers. Shown only once the film has a frame and the stall's cut-outs are decoded: frame 0 is the poster. */
export function FilmSet({scene, set, load, play}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const playRef = useRef(play);
  playRef.current = play;
  const stall = SCENES[scene].stall;

  useEffect(() => {
    const v = video.current;
    const el = ref.current;
    if (!load || !v || !el) return;
    let gone = false;
    v.src = `${filmBase(scene, set)}.${extension(v)}`;
    const film = new Promise<void>((ok) => {
      v.addEventListener('loadeddata', () => ok(), {once: true});
      v.addEventListener('canplay', () => ok(), {once: true});
    });
    v.load();
    // iOS loads nothing until asked to play: a muted inline play starts the download; the play effect pauses it if unwanted
    v.play().then(() => { if (!gone && !playRef.current) v.pause(); }).catch(() => {});
    const art = [...el.querySelectorAll<HTMLImageElement>('img[data-src]')].map((img) => {
      img.src = img.dataset.src!;
      return img.decode().catch(() => {});
    });
    Promise.all([film, ...art]).then(() => { if (!gone) setReady(true); });
    return () => { gone = true; };
  }, [load, scene, set]);

  useEffect(() => {
    const v = video.current;
    if (!v || !ready) return;
    if (play) v.play().catch(() => {}); else v.pause();
  }, [play, ready]);

  return (
    <div ref={ref} className={clsx(styles.set, ready && styles.ready)} data-set={set}>
      <video ref={video} className={styles.video} disablePictureInPicture disableRemotePlayback muted playsInline loop preload="none" />
      {stall && (
        <>
          <i className={styles.sign}><img alt="" decoding="async" data-src={stallArt('sign', set)} /></i>
          <img className={styles.ant} alt="" decoding="async" data-src={stallArt('ant', set)} />
          {PUPILS.map((p, k) => (
            <i key={k} className={clsx(styles.eye, k ? styles.eyeRight : styles.eyeLeft)} data-eye="">
              <b className={styles.pupil} style={{transform: pupilTransform(p.rest[0], p.rest[1])}} />
            </i>
          ))}
        </>
      )}
    </div>
  );
}
