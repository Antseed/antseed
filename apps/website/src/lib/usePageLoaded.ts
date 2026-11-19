import {useEffect, useState} from 'react';

/**
 * True once the page's `load` event has fired. Decorative images that aren't the first paint wait for it, so on a slow phone they
 * never take bandwidth from the hero painting, the styles or the fonts.
 */
export function usePageLoaded(): boolean {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (document.readyState === 'complete') { setLoaded(true); return; }
    const done = () => setLoaded(true);
    window.addEventListener('load', done, {once: true});
    return () => window.removeEventListener('load', done);
  }, []);
  return loaded;
}
