import {useEffect} from 'react';

/** How long the target is held in place while the accordion settles (its height transition is 250ms). */
const SETTLE_MS = 450;

/**
 * A link to a `<details>` inside the element with id `scopeId` (`#question-id`) opens it and keeps it in view. Opening one in an
 * exclusive group closes another above it, which pulls the page up while it collapses; the target is held at the top of the screen
 * on every frame until that settles, so it lands where the link pointed.
 */
export function useDetailsHashLink(scopeId: string): void {
  useEffect(() => {
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      const id = decodeURIComponent(window.location.hash.slice(1));
      const target = id ? document.getElementById(id) : null;
      if (!(target instanceof HTMLDetailsElement) || !document.getElementById(scopeId)?.contains(target)) return;
      target.open = true;
      const until = performance.now() + SETTLE_MS;
      const hold = () => {
        target.scrollIntoView({block: 'start', behavior: 'instant'});
        if (performance.now() < until) frame = requestAnimationFrame(hold);
      };
      hold();
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', follow);
    };
  }, [scopeId]);
}
