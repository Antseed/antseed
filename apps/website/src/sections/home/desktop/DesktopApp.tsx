import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import {usePageLoaded} from '../../../lib/usePageLoaded';
import {useSiteTheme} from '../../../lib/useSiteTheme';
import {APP_HEIGHT, APP_WIDTH, CAPTURES, PROMPT, SIGNATURE, captureSrc} from './script';
import {useDesktopLoop} from './useDesktopLoop';
import {useScaleToWidth} from './useScaleToWidth';
import styles from './DesktopApp.module.css';

/** The desktop app in a frosted window: its captured states in turn, with the cursor, typing and messages drawn over them. */
export function DesktopApp({className}: {className?: string}): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const dark = useSiteTheme() === 'dark';
  const loaded = usePageLoaded();   // the captures wait for the page, so they never race the first screen
  useScaleToWidth(frameRef, appRef, APP_WIDTH);
  useDesktopLoop(frameRef);

  return (
    <div ref={frameRef} className={clsx(styles.window, className)} role="img"
      aria-label="Antseed Desktop: a model is picked, Private is switched on, a prompt is sent and a signed reply comes in">
      <div ref={appRef} className={styles.app} aria-hidden="true">
        {CAPTURES.map(({id, file}) => (
          <img key={id} className={clsx(styles.capture, styles[id])} data-part={id === 'anon' ? undefined : id}
            src={loaded ? captureSrc(file, dark) : undefined} alt="" loading="lazy" decoding="async"
            {...(id === 'anon' ? {width: APP_WIDTH, height: APP_HEIGHT} : {})} />
        ))}
        <p className={styles.typed} data-part="typed"><span data-part="typedText" /><i className={styles.caret} /></p>
        <p className={styles.me} data-part="me">{PROMPT}</p>
        <div className={styles.reply} data-part="ai">
          <p data-part="replyText" />
          <span className={styles.signature} data-part="signature">{SIGNATURE}</span>
        </div>
        <img className={styles.cursor} data-part="cursor" src="/site/assets/home/desktop/cursor.svg" width={21} height={27} alt="" loading="lazy" />
      </div>
    </div>
  );
}
