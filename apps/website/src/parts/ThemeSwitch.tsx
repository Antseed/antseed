import type {JSX} from 'react';
import clsx from 'clsx';
import {useColorMode} from '@docusaurus/theme-common';
import {setThemeAnimated} from '../lib/theme';
import styles from './ThemeSwitch.module.css';

export default function ThemeSwitch({className}: {className?: string}): JSX.Element {
  const {colorMode, setColorMode} = useColorMode();
  const dark = colorMode === 'dark';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      title={dark ? 'Turn dark mode off' : 'Turn dark mode on'}
      className={clsx(styles.switch, className)}
      onClick={() => setThemeAnimated(setColorMode, dark ? 'light' : 'dark')}>
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill={dark ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4">
          <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" />
      </svg>
    </button>
  );
}
