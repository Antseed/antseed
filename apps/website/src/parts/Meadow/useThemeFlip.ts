import {useEffect, useRef, useState} from 'react';

const FLIP_MS = 2000;   // the page's crossfade plus margin

/** True for a moment after `value` changes (not on mount): films switch at once inside the page's crossfade instead of fading. */
export function useThemeFlip(value: unknown): boolean {
  const [flipping, setFlipping] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setFlipping(true);
    const t = window.setTimeout(() => setFlipping(false), FLIP_MS);
    return () => window.clearTimeout(t);
  }, [value]);
  return flipping;
}
