// The theme, before anything paints (loaded by every page as a plain script in the head): see the note in index.html.
// Then the paintings' turn to load, set here for the same reason: before anything paints (below).
{
const KEY = 'antseed.theme', MODES = ['system', 'light', 'dark'], root = document.documentElement, mq = matchMedia('(prefers-color-scheme: dark)');
let mode = 'system';
try { const v = localStorage.getItem(KEY); if (MODES.includes(v)) mode = v; } catch {}
const apply = (event) => {
  const t = mode === 'system' ? (mq.matches ? 'dark' : 'light') : mode;
  root.dataset.theme = t; root.style.colorScheme = t; root.style.backgroundColor = t === 'dark' ? '#0f1312' : '#fff';
  if (event) document.dispatchEvent(new Event('themechange'));
};
apply(false);
window.antseedTheme = {
  get: () => mode,
  set(m) {
    mode = MODES.includes(m) ? m : 'system'; try { localStorage.setItem(KEY, mode); } catch {}
    // a crossfade of the whole page, not a cut (the paintings run their own longer change under it: the hero's sweep, the footer's sun)
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(() => apply(true)); else apply(true);
  },
};
mq.addEventListener('change', () => { if (mode === 'system') apply(true); });
addEventListener('storage', (e) => { if (e.key === KEY) { mode = MODES.includes(e.newValue) ? e.newValue : 'system'; apply(true); } });   // set in another tab
}

// The paintings come as the visitor nears them, not all with the page. Every painted panel is a .wash whose picture is a CSS background,
// which a browser fetches at once however far below the fold it is. So the root says the paintings wait (.wash-lazy: launch.css then
// holds the picture of a panel not yet marked, never one of the page's first section, the first screen), and each .wash is marked
// .wash-near once it is within 1200px of the screen: those in the page, those of the homepage's sections, injected after load, and any
// added later. --wash and --wash-d are not touched, so the arrival (card-unveil.js) and the cursor's trail (wash-led.js) read them as
// ever. Not for still captures (?still, ?demo): every painting is there from the start. Without this script nothing waits.
{
const q = new URLSearchParams(location.search);
if (!q.has('still') && !q.has('demo') && window.IntersectionObserver && window.MutationObserver) {
  document.documentElement.classList.add('wash-lazy');
  // A panel on screen is marked at once. One only near at the first look gets a second look half a second later: a page still laying
  // itself out has it higher than it will be (the homepage's sections come in short, then their rows fill and push the rest down).
  const met = new WeakSet(), mark = (el) => { io.unobserve(el); on.unobserve(el); el.classList.add('wash-near'); };
  const io = new IntersectionObserver((seen) => {
    for (const e of seen) {
      const el = e.target, first = !met.has(el), box = e.boundingClientRect;
      met.add(el);
      if (!e.isIntersecting || el.classList.contains('wash-near')) continue;
      if (first && (box.top >= innerHeight || box.bottom <= 0)) { io.unobserve(el); setTimeout(() => { if (!el.classList.contains('wash-near')) io.observe(el); }, 500); } else mark(el);
    }
  }, { rootMargin: '1200px' });
  // During that half second nobody is looking at the panel with the margin: a visitor who scrolls the moment the page shows would reach
  // it unmarked, and its arrival would open on no painting. So the screen itself is watched too, and a panel on it is marked whatever.
  const on = new IntersectionObserver((seen) => { for (const e of seen) if (e.isIntersecting) mark(e.target); });
  const look = (w) => { io.observe(w); on.observe(w); };
  const watch = (el) => { if (el.matches?.('.wash:not(.wash-near)')) look(el); el.querySelectorAll('.wash:not(.wash-near)').forEach(look); };
  document.addEventListener('DOMContentLoaded', () => {
    watch(document);
    new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) watch(n); }).observe(document.body, { childList: true, subtree: true });
  });
}
}
