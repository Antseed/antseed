// effects/arrival.js: a painting's LED arrival. The site's hero/card-unveil.js (17 Nov), algorithm, values and timings unchanged; only
// what it finds changed: every .wash in the page that carries --wash, instead of the site's #sections, and data-effects to keep one out.
// Load it as a module at the end of <body> (DESIGN.md, Motion & Micro-interaction): <script type="module" src="effects/arrival.js">.
//
// Each painting arrives once, as it comes into view (a third of it showing). The panel is there first, plain in its own colour
// (--color-wash), its glass windows hidden; then its painting grows from the centre in an oval, the moving edge breaking into an LED
// matrix: round dots on the 8px grid, dense by the picture and scattering, dropping out further away, the painting coming in cell by cell
// just inside. Drawn as a cover in the panel's colour, under its windows, with holes cut in it, so the dots show the painting itself; at
// the end the cover is gone and the panel is as before. Paintings that come into view together follow one another (160ms apart).
// Day or night, it waits for the painting showing (--wash, or --wash-d at night) to be decoded, so its holes never show an empty panel.
// Until a painting has arrived it carries data-unveil (wait, soon, run): antseed.css holds it plain meanwhile, and effects/mosaic.js
// waits for it to go. A painting shown only later (hidden, then shown) arrives the first time it shows; replay(el) plays one again.
// Not with prefers-reduced-motion: reduce, nor with ?still in the URL (still captures): the paintings are there from the start.
// Opt a painting out with data-effects="none" (no effect) or data-effects="mosaic" (the mosaic only) on its .wash.
const root = document.documentElement;
const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches || new URLSearchParams(location.search).has('still');

const PITCH = 8;          // the grid, in CSS px, as the cursor's mosaic
const DOT = 0.42;         // a dot's radius, × the pitch
const BAND = 0.34;        // the fringe's width, in the oval's units (1 reaches the panel's corners)
const SOLID = 0.22;       // the inner part of the fringe where the painting comes in cell by cell
const DELAY = 150, DURATION = 1500, STAGGER = 160;   // ms: the panel plain, then the painting; panels arriving together, one after another
const ease = (t) => 1 - (1 - t) ** 3;
const hash = (x, y, s) => { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
// night: antseed.js's data-theme on <html>; without it, the system's setting
const night = () => (root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
const takes = (el) => { const v = el.dataset.effects; return v == null || v.split(/\s+/).includes('arrival'); };

// the painting the panel shows now (day or night), loaded before the cover lifts, so its holes never show an empty panel
const urlOf = (el) => {
  const cs = getComputedStyle(el), v = (night() && cs.getPropertyValue('--wash-d').trim()) || cs.getPropertyValue('--wash');
  const m = /url\(\s*['"]?([^'")]+)/.exec(v);
  return m && new URL(m[1], document.baseURI).href;
};
const decode = (src) => { if (!src) return Promise.resolve(); const i = new Image(); i.src = src; return i.decode().catch(() => {}); };

const running = new Set(), turn = new WeakMap();   // turn: each panel's latest arrival; an older one still running stops
async function unveil(el, after) {
  const me = (turn.get(el) || 0) + 1; turn.set(el, me);
  const stale = () => turn.get(el) !== me;
  await Promise.all([decode(urlOf(el)), wait(DELAY + after)]);
  if (stale()) return;
  const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) { delete el.dataset.unveil; return; }
  const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(w * dpr), H = Math.round(h * dpr), p = PITCH * dpr, r = DOT * p;
  const canvas = Object.assign(document.createElement('canvas'), { className: 'cu', width: W, height: H, ariaHidden: 'true' });
  canvas.style.cssText = 'position:absolute;inset:0;z-index:-1;width:100%;height:100%;pointer-events:none';   // over the painting, under everything in the panel (.wash isolates)
  const g = canvas.getContext('2d');
  const cells = [];
  for (let j = 0, rows = Math.ceil(H / p), cols = Math.ceil(W / p); j < rows; j++) for (let i = 0; i < cols; i++) {
    const cx = (i + 0.5) * p, cy = (j + 0.5) * p;
    cells.push({ x: i * p, y: j * p, d: Math.hypot((cx - W / 2) / (W / 2), (cy - H / 2) / (H / 2)) / Math.SQRT2, a: hash(i, j, 1), b: hash(i, j, 2) });
  }
  const run = { fill: getComputedStyle(el).backgroundColor, el };   // the panel's own colour under its painting (--color-wash)
  const draw = (f) => {
    g.globalCompositeOperation = 'source-over'; g.fillStyle = run.fill; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.beginPath();
    const inner = f - BAND;
    if (inner > 0) g.ellipse(W / 2, H / 2, inner * W / Math.SQRT2, inner * H / Math.SQRT2, 0, 0, Math.PI * 2);
    for (const c of cells) {
      const e = (f - c.d) / BAND; if (e <= 0 || e >= 1.05) continue;
      if (e > 1 - SOLID && c.a < (e - 1 + SOLID) / SOLID) { g.rect(c.x, c.y, p, p); continue; }   // the painting, cell by cell
      if (e < 1 && c.b <= Math.pow(e, 1.6)) { g.moveTo(c.x + p / 2 + r, c.y + p / 2); g.arc(c.x + p / 2, c.y + p / 2, r, 0, Math.PI * 2); }   // a dot
    }
    g.fill();
  };
  draw(0); el.prepend(canvas); el.dataset.unveil = 'run';   // the canvas takes over from the CSS's plain panel, in the same colour
  running.add(run);
  const t0 = performance.now();
  await new Promise((done) => {
    const frame = (now) => {
      if (stale()) return done();
      const t = Math.min(1, (now - t0) / DURATION);
      draw(ease(t) * (1 + BAND + 0.02));
      if (t < 1) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
  running.delete(run); canvas.remove();
  if (!stale()) delete el.dataset.unveil;
}

// play a panel's arrival again, now: back to its plain colour, the windows gone, then the painting growing from the centre and the
// windows popping in, as the first time. An arrival still running on it stops where it is
let watch = null;
export function replay(el) {
  if (STILL || !el || !takes(el) || !getComputedStyle(el).getPropertyValue('--wash').trim()) return;
  watch?.forget(el);
  el.querySelector(':scope > canvas.cu')?.remove();
  el.dataset.unveil = 'soon';
  unveil(el, 0).catch(() => delete el.dataset.unveil);
}

const panels = STILL ? [] : [...document.querySelectorAll('.wash')].filter((el) => takes(el) && getComputedStyle(el).getPropertyValue('--wash').trim());
if (panels.length) {
  const seen = new Map();
  const shown = (el) => (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : getComputedStyle(el).visibility !== 'hidden');
  // in view by a third, and showing: it arrives, after those that came in just before it
  const go = (el, k = 0) => {
    if (el.dataset.unveil !== 'wait' || !seen.get(el) || !shown(el)) return false;
    el.dataset.unveil = 'soon'; io.unobserve(el); seen.delete(el);
    unveil(el, k * STAGGER).catch(() => delete el.dataset.unveil);
    return true;
  };
  const io = new IntersectionObserver((entries) => {
    let k = 0;
    for (const e of entries) { seen.set(e.target, e.isIntersecting); if (go(e.target, k)) k++; }
  }, { threshold: 0.3 });
  watch = { forget: (el) => { io.unobserve(el); seen.delete(el); } };
  // a panel in view but hidden arrives once it shows
  const mo = new MutationObserver((ms) => ms.forEach((m) => go(m.target)));
  for (const el of panels) {
    el.dataset.unveil = 'wait';
    io.observe(el);
    mo.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert'] });
  }
  // the theme flips mid-arrival (antseed.js's themechange): the cover takes the panel's other colour (the CSS swaps the painting under it)
  document.addEventListener('themechange', () => running.forEach((r) => { r.fill = getComputedStyle(r.el).backgroundColor; }));
}
