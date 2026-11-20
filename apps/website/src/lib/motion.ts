/** The visitor asked for reduced motion. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export const prefersReducedMotion = (): boolean => window.matchMedia(REDUCED_MOTION_QUERY).matches;

/** Still mode: reduced motion, or a still capture (`?still` / `?demo`). Paintings, films and reveals are
 *  there from the start and nothing animates. Always false during SSR. */
export function isStill(): boolean {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search);
  return q.has('still') || q.has('demo') || prefersReducedMotion();
}
