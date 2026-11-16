import {useEffect, useState} from 'react';
import styles from './DesktopScreens.module.css';

/**
 * Antseed Desktop, as the app really looks: three screenshots of the
 * Desktop 0.2.84 renderer (Home, the model picker, Agents & apps) in a
 * window frame. They cross-fade on a timer; the tabs under the window jump
 * to a screen. Reduced motion holds the current screen.
 */

const SCREENS = [
  {key: 'home', label: 'Home', src: '/img/desktop/desktop-home.webp', alt: 'Antseed Desktop home screen: "Ask anything, on any model", a chat box on a free model, and the Anonymous and Private switch'},
  {key: 'picker', label: 'Models', src: '/img/desktop/desktop-picker.webp', alt: 'The Antseed Desktop model picker, listing free models with Text, Image and Video tabs'},
  {key: 'apps', label: 'Agents & apps', src: '/img/desktop/desktop-apps.webp', alt: 'The Agents & apps screen in Antseed Desktop, with Claude Code, Codex, OpenCode, Hermes and other apps to connect'},
];

const HOLD_MS = 4200;

export function DesktopScreens() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const t = window.setTimeout(() => setActive((i) => (i + 1) % SCREENS.length), HOLD_MS);
    return () => window.clearTimeout(t);
  }, [active, paused]);

  return (
    <div className={styles.wrap} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className={styles.window}>
        <div className={styles.bar} aria-hidden="true">
          <span className={styles.dots}><i /><i /><i /></span>
          <span className={styles.title}>Antseed Desktop</span>
        </div>
        <div className={styles.screens}>
          {SCREENS.map((s, i) => (
            <img
              key={s.key}
              src={s.src}
              alt={s.alt}
              width={1600}
              height={1000}
              loading={i === 0 ? 'eager' : 'lazy'}
              decoding="async"
              className={`${styles.screen} ${i === active ? styles.active : ''}`}
              aria-hidden={i === active ? undefined : true}
            />
          ))}
        </div>
      </div>
      <div className={styles.tabs} role="tablist" aria-label="Antseed Desktop screens">
        {SCREENS.map((s, i) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={i === active}
            className={`${styles.tab} ${i === active ? styles.tabActive : ''}`}
            onClick={() => setActive(i)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
