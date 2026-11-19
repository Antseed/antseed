import assert from 'node:assert/strict';
import {test} from 'node:test';

type Entry = {url?: string; element?: unknown};

/** A minimal page: an element tree, a loaded document and a largest-paint observer the test can feed. */
function page() {
  const el = (parent: El | null = null): El => ({parent, contains(o: unknown) { for (let n = o as El | null; n; n = n.parent) if (n === this) return true; return false; }});
  type El = {parent: El | null; contains(o: unknown): boolean};
  let hero: El | null = null;
  const observers: Array<(list: {getEntries(): Entry[]}) => void> = [];
  const timers: Array<() => void> = [];
  Object.assign(globalThis, {
    document: {readyState: 'complete', getElementById: (id: string) => (id === 'hero' ? hero : null)},
    window: {setTimeout: (fn: () => void) => timers.push(fn), addEventListener() {}},
    PerformanceObserver: Object.assign(class {
      constructor(cb: (list: {getEntries(): Entry[]}) => void) { observers.push(cb); }
      observe() {}
      disconnect() {}
    }, {supportedEntryTypes: ['largest-contentful-paint']}),
  });
  return {
    el,
    setHero(h: El | null) { hero = h; },
    paint(entries: Entry[]) { observers.forEach((cb) => cb({getEntries: () => entries})); },
    timeout() { timers.splice(0).forEach((fn) => fn()); },
  };
}

const settled = async (p: Promise<void>) => {
  let done = false;
  void p.then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  return done;
};

let fresh = 0;
const load = () => import(`./heroPainted.ts?case=${fresh++}`) as Promise<typeof import('./heroPainted.ts')>;

test('on the homepage it was loaded with, media waits for the hero painting, not for other paints', async () => {
  const p = page();
  const hero = p.el();
  p.setHero(hero);
  const {whenHeroPainted} = await load();
  const ready = whenHeroPainted();
  assert.equal(await settled(ready), false);
  p.paint([{url: '/logo.svg', element: p.el()}]);
  assert.equal(await settled(ready), false);
  p.paint([{url: '/meadow-day.webp', element: p.el(hero)}]);
  assert.equal(await settled(ready), true);
});

test('where the browser never reports the painting, it gives up after the fallback wait', async () => {
  const p = page();
  p.setHero(p.el());
  const {whenHeroPainted} = await load();
  const ready = whenHeroPainted();
  assert.equal(await settled(ready), false);
  p.timeout();
  assert.equal(await settled(ready), true);
});

test('a page without a hero does not settle the homepage it was loaded with', async () => {
  const p = page();
  const hero = p.el();
  p.setHero(hero);
  const {whenHeroPainted} = await load();
  p.setHero(null);
  assert.equal(await settled(whenHeroPainted()), true);
  p.setHero(hero);
  assert.equal(await settled(whenHeroPainted()), false);
});

test('a homepage reached by an in-site link is not held back for a paint the browser will not report', async () => {
  const p = page();
  const {whenHeroPainted} = await load();
  assert.equal(await settled(whenHeroPainted()), true);
  p.setHero(p.el());
  assert.equal(await settled(whenHeroPainted()), true);
});
