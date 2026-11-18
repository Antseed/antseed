import type {JSX} from 'react';
import clsx from 'clsx';
import {useColorMode} from '@docusaurus/theme-common';
import {setThemeAnimated} from '../lib/theme';
import styles from './ThemeSwitch.module.css';

/** The day/night switch (on = dark). A click makes the theme showing the visitor's explicit choice; until then the site follows the
 *  system (Docusaurus' respectPrefersColorScheme). */
export default function ThemeSwitch({className}: {className?: string}): JSX.Element {
  const {colorMode, setColorMode} = useColorMode();
  const dark = colorMode === 'dark';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark theme"
      className={clsx(styles.switch, className)}
      onClick={() => setThemeAnimated(setColorMode, dark ? 'light' : 'dark')}>
      <span className={clsx(styles.icon, styles.sun)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="8" cy="8" r="2.75" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
        </svg>
      </span>
      <span className={clsx(styles.icon, styles.moon)}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" />
        </svg>
      </span>
      <i className={styles.knob} aria-hidden="true" />
    </button>
  );
}
