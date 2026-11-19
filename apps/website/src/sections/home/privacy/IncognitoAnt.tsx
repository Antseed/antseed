import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import {usePageLoaded} from '../../../lib/usePageLoaded';
import {useStill} from '../../../lib/useStill';
import {CLIPS, useIncognitoAnt} from './useIncognitoAnt';
import styles from './Privacy.module.css';

const POSTER = '/site/assets/home/ant-incognito-idle-poster.webp';
const WIDTH = 480;
const HEIGHT = 798;

/** The incognito ant sitting on the panel's top edge; a click makes her laugh. Decorative and inert in still mode. */
export function IncognitoAnt(): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  const still = useStill();
  const loaded = usePageLoaded();   // the poster waits for the page, so it never races the first screen
  useIncognitoAnt(ref);
  return (
    <button ref={ref} className={styles.ant} type="button" aria-label="Tickle the ant" disabled={still} aria-hidden={still || undefined} tabIndex={still ? -1 : undefined}>
      {CLIPS.map((clip) => (
        <video
          key={clip}
          className={clsx(styles.clip, clip === 'idle' && styles.idle)}
          data-clip={clip}
          data-shown={clip === 'idle' ? '' : undefined}
          poster={clip === 'idle' && loaded ? POSTER : undefined}
          loop={clip === 'idle'}
          width={WIDTH}
          height={HEIGHT}
          muted
          playsInline
          preload="none"
          disablePictureInPicture
          disableRemotePlayback
          aria-hidden="true"
        />
      ))}
    </button>
  );
}
