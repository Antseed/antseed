import {useEffect, useState} from 'react';

const QUERY = '(hover: hover) and (pointer: fine)';

/** True on devices with a mouse (a fine pointer that hovers). False during SSR. */
export function useFinePointer(): boolean {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const update = () => setFine(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return fine;
}
