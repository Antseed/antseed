import type {JSX} from 'react';
import clsx from 'clsx';
import styles from './ThemedImg.module.css';

type Props = {
  day: string;
  night: string;
  alt: string;
  width?: number;
  height?: number;
  className?: string;
};

/** A day/night image pair; CSS shows the current theme's, and lazy loading keeps the hidden one from downloading (an eager pair would
 *  fetch both, so a first-screen picture is a Wash instead). */
export function ThemedImg({day, night, alt, width, height, className}: Props): JSX.Element {
  const common = {width, height, loading: 'lazy', decoding: 'async'} as const;
  return (
    <>
      <img {...common} className={clsx(styles.day, className)} src={day} alt={alt} />
      <img {...common} className={clsx(styles.night, className)} src={night} alt="" aria-hidden="true" />
    </>
  );
}
