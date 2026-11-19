import {useEffect, useState} from 'react';

const FALLBACK_MS = 3000;

/**
 * The hero the page was loaded with, if it opened on the homepage. The browser reports the largest paint only for the page it
 * loaded, so only this hero's painting can be waited for. A hero mounted later by an in-site link isn't held back.
 */
const firstHero = typeof document === 'undefined' ? null : document.getElementById('hero');

let painted: Promise<void> | null = null;

function loaded(): Promise<void> {
  if (document.readyState === 'complete') return Promise.resolve();
  return new Promise((resolve) => window.addEventListener('load', () => resolve(), {once: true}));
}

/** Resolves once the browser reports a painting inside `hero` as the page's largest paint, or after a short wait where it can't say. */
function heroPaint(hero: Element): Promise<void> {
  const observable = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('largest-contentful-paint');
  if (!observable) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { observer.disconnect(); clearTimeout(timer); resolve(); };
    const observer = new PerformanceObserver((list) => {
      const shown = list.getEntries().some((e) => {
        const paint = e as PerformanceEntry & {url?: string; element?: Element | null};
        return Boolean(paint.url) && Boolean(paint.element && hero.contains(paint.element));
      });
      if (shown) done();
    });
    observer.observe({type: 'largest-contentful-paint', buffered: true});
    const timer = window.setTimeout(done, FALLBACK_MS);
  });
}

/**
 * Resolves once the page has loaded and, on the homepage the visitor landed on, once its hero painting is on screen. Decorative
 * media below or behind the first screen waits for it, so on a slow phone it never takes bandwidth from the painting, the styles
 * or the fonts. Elsewhere, and on a homepage reached by an in-site link, it resolves at load.
 */
export function whenHeroPainted(): Promise<void> {
  const hero = document.getElementById('hero');
  if (!hero || hero !== firstHero) return loaded();
  painted ??= loaded().then(() => heroPaint(hero));
  return painted;
}

/** Runs `fn` once the hero is painted (see `whenHeroPainted`), unless cancelled first; returns the cancel. */
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
