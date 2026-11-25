import {useEffect, useState} from 'react';
import {REDUCED_MOTION_QUERY, isStill} from './motion';

export function useStill(): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    setStill(isStill());
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const on = () => setStill(isStill());
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return still;
}
