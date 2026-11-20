import {useEffect, useState, type RefObject} from 'react';

/** True while `ref` is within `rootMargin` of the screen. With `once`, stays true after the first time. */
export function useInView<T extends Element>(ref: RefObject<T | null>, {rootMargin = '0px', once = false, threshold = 0} = {}): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setInView(true); return; }
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setInView(true); if (once) io.disconnect(); } else if (!once) setInView(false);
    }, {rootMargin, threshold});
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin, once, threshold]);
  return inView;
}
