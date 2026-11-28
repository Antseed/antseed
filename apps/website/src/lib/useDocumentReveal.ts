import {useEffect} from 'react';
import {isStill} from './motion';

const STAGGER_MS = 50;
const SETTLE_MS = 900;
const MAX_BATCH_INDEX = 8;
/** `data-rv="lead"` (a first screen's offer) animates by CSS alone, from the first paint. */
const OBSERVED = "[data-rv]:not([data-rv='lead'])";

/** Set once hydrated, so the motion gate's safety timeout (motionGate.ts) keeps the gate. */
declare global {
  interface Window { __siteMotionReady?: boolean }
}

/**
 * Reveals every `[data-rv]` block in the document as it scrolls into view, in top-to-bottom batches (`data-rv="panel"` for large
 * panels). Blocks are hidden before the first paint by CSS under `html[data-motion]`
 * (set by the head script), so neither a hard load nor a client-side navigation ever shows content and then hides it again.
 * Mounted once, in Root; new pages and late-mounted blocks are picked up by the MutationObserver.
 */
export function useDocumentReveal(): void {
  useEffect(() => {
    window.__siteMotionReady = true;
    if (isStill() || typeof IntersectionObserver === 'undefined') {
      delete document.documentElement.dataset.motion;
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries
        .filter((e) => e.isIntersecting)
        .map((e) => e.target as HTMLElement)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
        .forEach((block, i) => {
          const order = Math.min(i, MAX_BATCH_INDEX);
          io.unobserve(block);
          block.style.setProperty('--rv-i', String(order));
          block.setAttribute('data-rv-in', '');
          window.setTimeout(() => {
            block.removeAttribute('data-rv');
            block.removeAttribute('data-rv-in');
            block.style.removeProperty('--rv-i');
          }, order * STAGGER_MS + SETTLE_MS);
        });
    }, {rootMargin: '0px 0px -40px 0px'});

    // a block with no box (display: contents) never intersects: release it rather than observe it for ever
    const watch = (b: Element) => {
      if (getComputedStyle(b).display === 'contents') { b.removeAttribute('data-rv'); return; }
      io.observe(b);
    };
    const observeWithin = (scope: Element) => {
      if (scope.matches(OBSERVED)) watch(scope);
      scope.querySelectorAll(OBSERVED).forEach(watch);
    };
    observeWithin(document.body);
    const mo = new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach((n) => n instanceof Element && observeWithin(n));
    });
    mo.observe(document.body, {childList: true, subtree: true});
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, []);
}
