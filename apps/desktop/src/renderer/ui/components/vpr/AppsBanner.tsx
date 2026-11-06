import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { usePrivateMode } from './PrivacyToggle';
import styles from './AppsBanner.module.scss';

const ART = {
  day: {
    poster: new URL('../../../assets/v4/banner/agents-banner-day-poster.jpg', import.meta.url).href,
    loop: new URL('../../../assets/v4/banner/agents-banner-day-loop.mp4', import.meta.url).href,
  },
  night: {
    poster: new URL('../../../assets/v4/banner/agents-banner-private-poster.jpg', import.meta.url).href,
    loop: new URL('../../../assets/v4/banner/agents-banner-private-loop.mp4', import.meta.url).href,
  },
} as const;

/** Apps page banner: a calm loop per mode, crossfading when the mode flips. */
export function AppsBanner({ title, subtitle }: { title: string; subtitle: string }) {
  const privateMode = usePrivateMode();
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div className={`${styles.banner}${privateMode ? ` ${styles.night}` : ''}`}>
      {(['day', 'night'] as const).map((mode) => (
        <div
          key={mode}
          className={`${styles.layer} ${mode === 'day' ? styles.hazeDay : styles.hazeNight}${(mode === 'night') === privateMode ? '' : ` ${styles.hidden}`}`}
          aria-hidden="true"
        >
          {reducedMotion
            ? <img src={ART[mode].poster} alt="" className={styles.art} />
            : <video src={ART[mode].loop} poster={ART[mode].poster} className={styles.art} autoPlay muted loop playsInline />}
        </div>
      ))}
      <div className={styles.text}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.subtitle}>{subtitle}</p>
      </div>
    </div>
  );
}
