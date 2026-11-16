import {useEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react';

/**
 * Mounts decorative, script-heavy children (animated demos, canvases) only
 * when they come within `rootMargin` of the viewport. Until then — and in the
 * static HTML — a box of the same size holds the space, so nothing shifts
 * (CLS) and below-the-fold demos cost no JS, image requests or rAF work on
 * first paint. Never wrap real content or links: they must stay in the HTML.
 */
export function LazyMount({
  children,
  className,
  style,
  rootMargin = '400px 0px',
}: {
  children: ReactNode;
  className?: string;
  /** give it the children's size (height or aspect-ratio) to avoid layout shift */
  style?: CSSProperties;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setMounted(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMounted(true);
          observer.disconnect();
        }
      },
      {rootMargin},
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin]);

  return (
    <div ref={ref} className={className} style={style}>
      {mounted ? children : null}
    </div>
  );
}
