import {useRef, type JSX} from 'react';
import {useInView} from '../../../lib/useInView';
import {CHAPTERS} from './chapters';
import {useFilmChapters} from './useFilmChapters';
import styles from './GatewayFilm.module.css';

const POSTER = '/site/assets/home/gateway-demo/gateway-film-poster.jpg';
const FILM = '/site/assets/home/gateway-demo/gateway-film.mp4';
const LOAD_MARGIN = '1200px';

/** The Gateway console on film, in a browser window, with chapter buttons under it that jump and light as it plays. */
export function GatewayFilm(): JSX.Element {
  const frameRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  // neither the poster nor the film is requested until the window nears the screen
  const near = useInView(frameRef, {rootMargin: LOAD_MARGIN, once: true});
  const jump = useFilmChapters(videoRef, buttonsRef, near);

  return (
    <figure ref={frameRef} className={styles.window}>
      <div className={styles.bar}>
        <span className={styles.lights} aria-hidden="true"><i /><i /><i /></span>
        <span className={styles.address}>localhost:8379/console</span>
      </div>
      <video ref={videoRef} className={styles.video} muted playsInline loop preload="none" poster={near ? POSTER : undefined}
        aria-label="The Antseed Gateway console in use: a question answered by a provider on the network, the list of models and providers, an API key created with a daily and monthly budget, then usage and routing rules">
        {near && <source src={FILM} type="video/mp4" />}
      </video>
      <div className={styles.chapters} role="group" aria-label="Chapters">
        {CHAPTERS.map((c, i) => (
          <button key={c.label} ref={(el) => { buttonsRef.current[i] = el; }} type="button" className={styles.chapter}
            aria-pressed={i === 0} onClick={() => jump(i)}>{c.label}</button>
        ))}
      </div>
    </figure>
  );
}
