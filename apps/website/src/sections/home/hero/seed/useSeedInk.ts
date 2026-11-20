import {useEffect, useRef, useState} from 'react';
import {isStill} from '../../../../lib/motion';
import {useSiteTheme} from '../../../../lib/useSiteTheme';
import {ASSETS} from '../data';

/** Going to night the seeds light up last, once the painting's night has mostly faded in. */
const LIGHT_UP_MS = 900;

/** The seed's picture: the day one, or at night the one glowing amber. */
export function useSeedInk(): string {
  const night = useSiteTheme() === 'dark';
  const [src, setSrc] = useState(ASSETS.seedDay);
  const loaded = useRef(false);
  useEffect(() => {
    const want = night ? ASSETS.seedNight : ASSETS.seedDay;
    const flip = loaded.current;
    loaded.current = true;
    if (!flip || !night || isStill()) { setSrc(want); return; }
    const t = window.setTimeout(() => setSrc(want), LIGHT_UP_MS);
    return () => clearTimeout(t);
  }, [night]);
  return src;
}
