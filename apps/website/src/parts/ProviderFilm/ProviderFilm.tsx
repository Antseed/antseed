import {useEffect, useRef, useState, type CSSProperties, type JSX} from 'react';
import clsx from 'clsx';
import {useInView} from '../../lib/useInView';
import {usePageVisible} from '../../lib/usePageVisible';
import {useSiteTheme} from '../../lib/useSiteTheme';
import {useStill} from '../../lib/useStill';
import {useFinePointer} from '../../lib/useFinePointer';
import {FilmSet} from './FilmSet';
import {SCENES, type SceneName, type SetName} from './scenes';
import {useStallEyes} from './useStallEyes';
import styles from './ProviderFilm.module.css';

type Props = {
  scene: SceneName;
  /** Lays the film box over the panel's painting. Set `--film-left`, `--film-width` and `--film-y` (the painting's
   *  background-position-y) on it to match how the panel crops its painting; defaults: 0, 100%, 85%. */
  className?: string;
};

const LOAD_MARGIN = '600px 0px';

/**
 * The providers' paintings, moving: put it first inside a `Wash` that shows the same scene's poster. One looping film per theme whose
 * first frame is the poster, so nothing visibly changes when it takes over; the stall adds its swinging price board and the ant's
 * pupils following the pointer. Only the theme on screen is fetched, nothing before the panel nears the screen, and it plays only on
 * screen with the tab visible; with reduced motion or a still capture the poster stays.
 */
export function ProviderFilm({scene, className}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const near = useInView(ref, {rootMargin: LOAD_MARGIN, once: true});
  const seen = useInView(ref);
  const visible = usePageVisible();
  const still = useStill();
  const theme: SetName = useSiteTheme() === 'dark' ? 'night' : 'day';
  const [wanted, setWanted] = useState<Record<SetName, boolean>>({day: false, night: false});
  const running = seen && visible && !still;

  useEffect(() => {
    if (near && !still) setWanted((w) => (w[theme] ? w : {...w, [theme]: true}));
  }, [near, still, theme]);
  const fine = useFinePointer();
  useStallEyes(ref, running && fine && SCENES[scene].stall);

  return (
    <div ref={ref} className={clsx(styles.film, running && styles.running, className)} style={{'--film-aspect': SCENES[scene].aspect} as CSSProperties} aria-hidden="true">
      {(['day', 'night'] as const).map((set) => (
        <FilmSet key={set} scene={scene} set={set} load={wanted[set]} play={running && theme === set} />
      ))}
    </div>
  );
}
