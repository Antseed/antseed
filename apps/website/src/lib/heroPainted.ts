import {useEffect, useState} from 'react';

const FALLBACK_MS = 3000;

let painted: Promise<void> | null = null;

function loaded(): Promise<void> {
  if (document.readyState === 'complete') return Promise.resolve();
  return new Promise((resolve) => window.addEventListener('load', () => resolve(), {once: true}));
}

/** Resolves once the browser reports the hero painting as the page's largest paint, or after a short wait where it can't say. */
function heroPaint(): Promise<void> {
  const observable = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('largest-contentful-paint');
  if (!observable || !document.getElementById('hero')) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { observer.disconnect(); clearTimeout(timer); resolve(); };
    const observer = new PerformanceObserver((list) => {
      const hero = list.getEntries().some((e) => {
        const paint = e as PerformanceEntry & {url?: string; element?: Element | null};
        return Boolean(paint.url) && Boolean(paint.element?.closest('#hero'));
      });
      if (hero) done();
    });
    observer.observe({type: 'largest-contentful-paint', buffered: true});
    const timer = window.setTimeout(done, FALLBACK_MS);
  });
}

/**
 * Resolves once the page has loaded and the hero painting is on screen. Decorative media below or behind the first screen waits
 * for it, so on a slow phone it never takes bandwidth from the painting, the styles or the fonts.
 */
export function whenHeroPainted(): Promise<void> {
  painted ??= loaded().then(heroPaint);
  return painted;
}

/** Runs `fn` once the hero is painted, unless cancelled first; returns the cancel. */
export function afterHeroPainted(fn: () => void): () => void {
  let live = true;
  void whenHeroPainted().then(() => { if (live) fn(); });
  return () => { live = false; };
}

/** True once the hero painting is on screen (see `whenHeroPainted`). */
export function useHeroPainted(): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => afterHeroPainted(() => setDone(true)), []);
  return done;
}
