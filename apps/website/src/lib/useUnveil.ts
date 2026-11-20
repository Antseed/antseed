import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject} from 'react';
import {isStill} from './motion';
import {paintingUrl} from './ledGrid';
import {playCover} from './unveilCover';

/*
 * A painted panel's arrival: shown plain in its colour (children hidden), then its painting grows in from the centre (unveilCover.ts)
 * and the children pop in. Plays once, when a third of the panel is first in view; panels entering together play one after another.
 * State lives in `data-unveil` (wait → soon → run → removed) so Wash's CSS can hide and show the children, and the cursor trail can
 * wait for it. Nothing happens in still mode: the painting is simply there.
 */

const START_DELAY_MS = 150;
const STAGGER_MS = 160;
const VISIBLE_SHARE = 0.3;
/** Frames to wait for Wash to set its painting variable after the panel comes near (a React update). */
const URL_WAIT_FRAMES = 10;

type State = 'wait' | 'soon' | 'run';
const setState = (el: HTMLElement, s: State | null) => { if (s) el.dataset.unveil = s; else delete el.dataset.unveil; };

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const nextFrame = () => new Promise<void>((ok) => requestAnimationFrame(() => ok()));

// decode before the cover lifts, so its holes never show an empty panel
async function decodePainting(el: HTMLElement): Promise<void> {
  let url = paintingUrl(el);
  for (let i = 0; !url && i < URL_WAIT_FRAMES; i++) { await nextFrame(); url = paintingUrl(el); }
  if (!url) return;
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => {});
}

// each panel's latest arrival; a newer one (a replay) or an unmount cancels the one running
const generation = new WeakMap<HTMLElement, number>();
const bump = (el: HTMLElement) => { const n = (generation.get(el) ?? 0) + 1; generation.set(el, n); return n; };

async function arrive(el: HTMLElement, delay: number): Promise<void> {
  const me = bump(el);
  const cancelled = () => generation.get(el) !== me;
  setState(el, 'soon');
  await Promise.all([decodePainting(el), wait(START_DELAY_MS + delay)]);
  if (cancelled()) return;
  setState(el, 'run');
  await playCover(el, cancelled);
  if (!cancelled()) setState(el, null);
}
const start = (el: HTMLElement, delay: number) => { arrive(el, delay).catch(() => setState(el, null)); };

// One observer for all panels, so entries that arrive in the same callback can be staggered.
const inView = new Map<HTMLElement, boolean>();
let io: IntersectionObserver | null = null;
let mo: MutationObserver | null = null;
let watched = 0;

const isShown = (el: HTMLElement) => (el.checkVisibility ? el.checkVisibility({visibilityProperty: true}) : getComputedStyle(el).visibility !== 'hidden');

function tryStart(el: HTMLElement, order = 0): boolean {
  if (el.dataset.unveil !== 'wait' || !inView.get(el) || !isShown(el)) return false;
  stopWatching(el);
  start(el, order * STAGGER_MS);
  return true;
}

function watch(el: HTMLElement): void {
  if (!io) {
    io = new IntersectionObserver((entries) => {
      let order = 0;
      for (const e of entries) {
        const t = e.target as HTMLElement;
        inView.set(t, e.isIntersecting);
        if (tryStart(t, order)) order++;
      }
    }, {threshold: VISIBLE_SHARE});
    // a panel in view but hidden (an unselected tab) arrives once it is shown
    mo = new MutationObserver((records) => records.forEach((r) => tryStart(r.target as HTMLElement)));
  }
  watched++;
  setState(el, 'wait');
  io.observe(el);
  mo?.observe(el, {attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert']});
}

function stopWatching(el: HTMLElement): void {
  io?.unobserve(el);
  inView.delete(el);
}

function unwatch(el: HTMLElement): void {
  stopWatching(el);
  bump(el);
  setState(el, null);
  if (--watched <= 0) { io?.disconnect(); mo?.disconnect(); io = mo = null; watched = 0; }
}

/** Plays a panel's arrival again from the plain panel, cancelling one under way. Nothing in still mode. */
export function replayUnveil(el: HTMLElement | null): void {
  if (!el || isStill()) return;
  stopWatching(el);
  start(el, 0);
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The arrival for the panel in `ref`. A change of `replayKey` after mount plays it again (a newly chosen tab); `replay()` does the
 * same imperatively.
 */
export function useUnveil(ref: RefObject<HTMLElement | null>, enabled: boolean, replayKey?: unknown): {replay: () => void} {
  // layout effect: hide the children before the first paint after hydration rather than flash them
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled || isStill()) return;
    watch(el);
    return () => unwatch(el);
  }, [ref, enabled]);

  const replay = useCallback(() => { if (enabled) replayUnveil(ref.current); }, [ref, enabled]);

  const lastKey = useRef(replayKey);
  useEffect(() => {
    if (replayKey === lastKey.current) return;
    lastKey.current = replayKey;
    replay();
  }, [replayKey, replay]);

  return useMemo(() => ({replay}), [replay]);
}
