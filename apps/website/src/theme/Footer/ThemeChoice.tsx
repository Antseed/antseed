import {useEffect, useState, type JSX, type ReactNode} from 'react';
import {useColorMode} from '@docusaurus/theme-common';
import {setThemeAnimated} from '@site/src/lib/theme';
import styles from './ThemeChoice.module.css';

type Mode = 'light' | 'dark';

const MODES: readonly {mode: Mode; label: string; icon: ReactNode}[] = [
  {mode: 'light', label: 'Light theme', icon: <><circle cx="8" cy="8" r="2.75" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" /></>},
  {mode: 'dark', label: 'Dark theme', icon: <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" />},
];

/** Light or dark (dark is opt-in; the site does not follow the system, see docusaurus.config respectPrefersColorScheme). */
export default function ThemeChoice(): JSX.Element {
  const {colorMode, setColorMode} = useColorMode();
  // the effective mode is only certain in the browser; render Light until hydrated so SSR and the first client render agree
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const current: Mode = (hydrated && colorMode) || 'light';
  return (
    <div className={styles.choice} role="group" aria-label="Theme">
      {MODES.map(({mode, label, icon}) => (
        <button key={mode} type="button" className={styles.option} aria-label={label} aria-pressed={mode === current}
          onClick={() => setThemeAnimated(setColorMode, mode)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">{icon}</svg>
        </button>
      ))}
    </div>
  );
}
