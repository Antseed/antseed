import {useCallback, useEffect, useRef, useState} from 'react';
import useBrokenLinks from '@docusaurus/useBrokenLinks';
import {scrollToTop} from './scrollToTop';

export const INSTRUCTIONS_HASH = '#instructions';

/**
 * The flow's screen from the URL hash, so the browser's back button moves between the two. `back` pops the history entry when this
 * visit added it, and clears the hash otherwise (landed on #instructions directly).
 */
export function useStep(): {step: 1 | 2; back: () => void} {
  // the hash is a screen of this page, not an element: registered so the build's anchor check accepts links to it
  useBrokenLinks().collectAnchor(INSTRUCTIONS_HASH.slice(1));
  const [step, setStep] = useState<1 | 2>(1);
  const pushed = useRef(false);

  useEffect(() => {
    const sync = (e?: HashChangeEvent) => {
      const next = window.location.hash === INSTRUCTIONS_HASH ? 2 : 1;
      if (e && next === 2) pushed.current = true;
      setStep(next);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(scrollToTop, [step]);

  const back = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else {
      window.location.hash = '';
    }
  }, []);

  return {step, back};
}
