// The night's fireflies, drawn on one canvas per painting: the hero's (inside its night, so they come and go with the
// night's sweep) and the footer's meadow (a few, low over the ants). In the mosaic's lit colours.
// The hero has three depths. Far, toward the far ridge: tiny faint points that barely drift. Mid: a little larger, wandering slowly.
// Near: a handful that really fly, wandering with small darts and hovers, each blinking on its own rhythm (a quick rise, a hold, a long
// fade, then dark a while); each drifts in depth too, and when it is deep it passes behind the painting's foreground plants: the
// still's dark grass, leaves, stems and flowers, cut from it as a matte (assets/hero/night/whimsical-2-night-b-matte.webp, from row
// MATTE_TOP of the 1376×768 still down), placed as the still is (cover, 50% 0).
// Everything is in the painting's own pixels, mapped as its picture is fitted, so it holds at every size. One rAF loop for both places,
// running only while a place is on screen, the tab visible and the theme dark; glows are cached sprites. With reduced motion: still,
// drawn once where they rest, the far ones dimmer. Phones get fewer. The hero's canvas keeps the --fireflies knob (its CSS opacity).
const root = document.documentElement;
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const INKS = ['#d8f070', '#d8f070', '#a6e05a', '#ffb347'];
const MATTE_TOP = 499;

// a seeded random, so the flies are placed the same on every load
const rng = (s) => () => (s = (s * 16807) % 2147483647) / 2147483647;
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// one glow per colour: a white heart, the colour, its halo
const sprites = {};
const sprite = (c) => sprites[c] ||= (() => {
  const S = 64, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  const a = (k) => c + Math.round(k * 255).toString(16).padStart(2, '0');
  gr.addColorStop(0, '#fff'); gr.addColorStop(0.12, c); gr.addColorStop(0.2, a(0.85)); gr.addColorStop(0.4, a(0.3));
  gr.addColorStop(0.7, a(0.08)); gr.addColorStop(1, a(0));
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return cv;
})();

// the places: the painting's size and how it is fitted (cover, at fx fy), and where each kind of fly lives in it
const PLACES = [
  { sel: '.whimsical .paint', canvas: '.flies', seed: 11, img: [1376, 768], fit: [0.5, 0], matte: true,
    kinds: (phone) => [
      { n: phone ? 7 : 13, kind: 'far', y: [492, 548], d: [5, 8], a: [0.55, 0.9] },
      { n: phone ? 3 : 6, kind: 'mid', y: [540, 600], d: [10, 15], a: [0.6, 0.9] },
      { n: phone ? 4 : 7, kind: 'near', y: [555, 670], d: [30, 42], a: [0.9, 1], r: [80, 40] },
    ] },
  { sel: '.s-foot.meadow .scene', canvas: '.flies', seed: 7, img: [1920, 1080], fit: [0.46, 1],
    kinds: (phone) => [{ n: phone ? 2 : 3, kind: 'near', y: [770, 900], x: [560, 1330], d: [48, 64], a: [0.9, 1], r: [110, 55] }] },
];

const places = [];
let raf = 0, last = 0;

function init(def) {
  const box = document.querySelector(def.sel), cv = box?.querySelector(`canvas${def.canvas}`);
  if (!cv || places.some((P) => P.cv === cv)) return;
  // Whimsical 1's night is a multiplied wash: its flies sit beside it, not in it
  if (cv.parentElement.matches('.night') && !root.classList.contains('whimsical2')) box.append(cv);
  const P = { def, box, cv, g: cv.getContext('2d'), seen: false, flies: [], matte: null, t: 0 };
  // the matte, only for the night it was cut from (Whimsical 2's, not ?night=a, c), fetched once it is night
  if (def.matte && !box.dataset.night && root.classList.contains('whimsical2')) P.wantMatte = true;
  new ResizeObserver(() => { layout(P); paintStill(P); wake(); }).observe(cv);
  new IntersectionObserver(([e]) => { P.seen = e.isIntersecting; wake(); }).observe(box);
  places.push(P);
  layout(P);
}

// the canvas at its size and the device's pixels; the picture's fit; the flies placed in the part of the painting on screen
function layout(P) {
  const w = P.cv.clientWidth, h = P.cv.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  P.cv.width = Math.round(w * dpr); P.cv.height = Math.round(h * dpr);
  const [IW, IH] = P.def.img, s = Math.max(w / IW, h / IH);
  P.s = s; P.ox = (w - IW * s) * P.def.fit[0]; P.oy = (h - IH * s) * P.def.fit[1]; P.dpr = dpr;
  const x0 = Math.max(0, -P.ox / s), x1 = Math.min(IW, (w - P.ox) / s);   // the painting's columns on screen
  const phone = w < 640;
  if (P.flies.length && P.phone === phone && Math.abs(P.x0 - x0) < 2 && Math.abs(P.x1 - x1) < 2) return;
  P.phone = phone; P.x0 = x0; P.x1 = x1;
  const r = rng(P.def.seed), flies = [];
  for (const k of P.def.kinds(phone)) {
    const [lo, hi] = k.x ? [Math.max(x0, k.x[0]), Math.min(x1, k.x[1])] : [x0, x1], pad = (hi - lo) * 0.04;
    for (let i = 0; i < k.n; i++) {
      // spread across, each in its own share of the width, so they never bunch
      const hx = lo + pad + (hi - lo - 2 * pad) * (i + 0.15 + r() * 0.7) / k.n, hy = k.y[0] + (k.y[1] - k.y[0]) * r() ** (k.kind === 'far' ? 1.4 : 1);
      const f = { kind: k.kind, hx, hy, x: hx, y: hy, vx: 0, vy: 0, d: k.d[0] + (k.d[1] - k.d[0]) * r(), a: k.a[0] + (k.a[1] - k.a[0]) * r(),
        ink: sprite(INKS[Math.floor(r() * INKS.length)]), ph: [r() * 7, r() * 7, r() * 7, r() * 7], fq: [0.05 + r() * 0.08, 0.11 + r() * 0.12],
        blink: { t: -r() * 4, gap: 0, rise: 0, hold: 0, fade: 0 }, glow: 0 };
      if (k.kind === 'near') Object.assign(f, { rx: k.r[0], ry: k.r[1], th: r() * 6.28, mode: 'hover', mt: r() * 1.5, sp: 6, zf: 0.05 + r() * 0.05 });
      else f.amp = k.kind === 'far' ? 3 + r() * 5 : 10 + r() * 14;
      nextBlink(f, r);
      flies.push(f);
    }
  }
  P.flies = flies; P.r = rng(P.def.seed * 31);
}

// a firefly's flash: dark a while, a quick rise, a hold, a long fade (the far ones softer and slower)
function nextBlink(f, r) {
  const b = f.blink, far = f.kind !== 'near';
  b.gap = far ? 0.8 + r() * 3 : 0.3 + r() * 1.5; b.rise = far ? 0.5 + r() * 0.6 : 0.18 + r() * 0.25;
  b.hold = 0.1 + r() * (far ? 0.6 : 0.5); b.fade = far ? 1 + r() * 1.4 : 0.6 + r() * 0.9;
  b.base = far ? 0.3 + r() * 0.2 : 0.16 + r() * 0.12;
}
function glow(f, dt, r) {
  const b = f.blink; b.t += dt;
  const { gap, rise, hold, fade } = b;
  if (b.t > gap + rise + hold + fade) { b.t -= gap + rise + hold + fade; nextBlink(f, r); }
  const t = b.t - gap;
  const e = t < 0 ? 0 : t < rise ? ss(0, rise, t) : t < rise + hold ? 1 : 1 - ss(0, fade, t - rise - hold);
  return b.base + (1 - b.base) * e;
}

// the near ones' flight: a heading that wanders smoothly, a speed that changes with the mode (hovering, cruising, a short dart),
// a soft pull home once they stray, velocity eased toward what they want (snappy in a dart)
const MODES = {
  hover: { dur: [0.8, 2.4], sp: [3, 9], next: [['cruise', 0.65], ['dart', 1]] },
  cruise: { dur: [1.2, 3.2], sp: [16, 34], next: [['hover', 0.5], ['dart', 0.8], ['cruise', 1]] },
  dart: { dur: [0.16, 0.34], sp: [95, 150], next: [['hover', 0.6], ['cruise', 1]] },
};
function fly(f, dt, t, r) {
  f.mt -= dt;
  if (f.mt <= 0) {
    const p = r(), m = MODES[f.mode].next.find(([, c]) => p <= c)[0], M = MODES[m];
    f.mode = m; f.mt = M.dur[0] + (M.dur[1] - M.dur[0]) * r(); f.sp = M.sp[0] + (M.sp[1] - M.sp[0]) * r();
    if (m === 'dart') f.th += (r() < 0.5 ? -1 : 1) * (0.7 + r() * 1.5);
  }
  const turn = (f.mode === 'hover' ? 2.2 : 1.3) * (Math.sin(t * 0.9 + f.ph[0]) + 0.6 * Math.sin(t * 2.3 + f.ph[1]));
  f.th += turn * dt;
  // home: inside its ellipse it roams free; beyond it the heading bends back, harder the further out
  const dx = (f.hx - f.x) / f.rx, dy = (f.hy - f.y) / f.ry, out = Math.hypot(dx, dy) - 1;
  if (out > 0) {
    let d = Math.atan2(dy * f.ry, dx * f.rx) - f.th; d = Math.atan2(Math.sin(d), Math.cos(d));
    f.th += d * Math.min(1, dt * (1.5 + 4 * out));
  }
  const bob = f.mode === 'hover' ? Math.sin(t * 3.1 + f.ph[2]) * 7 : 0;
  const wx = Math.cos(f.th) * f.sp, wy = Math.sin(f.th) * f.sp * 0.6 + bob;
  const k = 1 - Math.exp(-dt * (f.mode === 'dart' ? 10 : 3));
  f.vx += (wx - f.vx) * k; f.vy += (wy - f.vy) * k;
  f.x += f.vx * dt; f.y += f.vy * dt;
  // depth: 0 in front of the plants, 1 behind them
  f.z = 0.5 + 0.5 * Math.sin(t * f.zf * 6.28 + f.ph[3]) * (0.7 + 0.3 * Math.sin(t * 0.37 + f.ph[0]));
}

function draw(P, dt, still) {
  const { g, s, dpr, flies } = P, t = (P.t += dt), r = P.r;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, P.cv.width, P.cv.height);
  g.setTransform(s * dpr, 0, 0, s * dpr, P.ox * dpr, P.oy * dpr);   // the painting's pixels from here
  const min = 7 / s;   // no glow under 7 CSS px across, however small the painting
  // behind: the far and mid ones, and the near ones as deep as they are; then the matte cuts them; then the near ones in front
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  const put = (f, a, d) => {
    if (a < 0.01) return;
    const R = Math.max(d, min) / 2;
    g.globalAlpha = Math.min(1, a); g.drawImage(f.ink, f.x - R, f.y - R, 2 * R, 2 * R);
    return R;
  };
  g.globalCompositeOperation = 'lighter';
  const front = [];
  for (const f of flies) {
    if (still) { f.x = f.hx; f.y = f.hy; f.glow = f.kind === 'near' ? 0.6 : f.kind === 'mid' ? 0.45 : 0.35; f.z = 0; }
    else {
      f.glow = glow(f, dt, r);
      if (f.kind === 'near') fly(f, dt, t, r);
      else { f.x = f.hx + f.amp * Math.sin(t * f.fq[0] * 6.28 + f.ph[0]); f.y = f.hy + f.amp * 0.5 * Math.sin(t * f.fq[1] * 6.28 + f.ph[1]); }
    }
    const a = f.a * f.glow;
    if (f.kind !== 'near') { const R = put(f, a, f.d); if (R) { bx0 = Math.min(bx0, f.x - R); by0 = Math.min(by0, f.y - R); bx1 = Math.max(bx1, f.x + R); by1 = Math.max(by1, f.y + R); } continue; }
    const b = P.matte ? ss(0.56, 0.72, f.z) : 0, d = f.d * (1 - 0.25 * f.z);   // deeper, a little smaller
    const R = put(f, a * b, d);
    if (R) { bx0 = Math.min(bx0, f.x - R); by0 = Math.min(by0, f.y - R); bx1 = Math.max(bx1, f.x + R); by1 = Math.max(by1, f.y + R); }
    front.push([f, a * (1 - b), d]);
  }
  // the matte over just the part where behind-flies are
  if (P.matte && bx1 > bx0) {
    const [IW] = P.def.img, mh = P.matte.height;
    const x0 = Math.max(0, Math.floor(bx0)), x1 = Math.min(IW, Math.ceil(bx1)), y0 = Math.max(MATTE_TOP, Math.floor(by0)), y1 = Math.min(MATTE_TOP + mh, Math.ceil(by1));
    if (x1 > x0 && y1 > y0) {
      g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 1;
      g.drawImage(P.matte, x0, y0 - MATTE_TOP, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      g.globalCompositeOperation = 'lighter';
    }
  }
  for (const [f, a, d] of front) put(f, a, d);
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
}

const night = () => root.dataset.theme === 'dark';
const live = (P) => P.seen && !document.hidden && night();
function loadMatte(P) {
  if (!P.wantMatte || P.matteLoading) return;
  P.matteLoading = true;
  const im = new Image(); im.src = new URL('/site/assets/hero/night/whimsical-2-night-b-matte.webp', import.meta.url).href;
  im.decode().then(() => { P.matte = im; paintStill(P); }, () => {});
}
// with reduced motion (or before the first frame): drawn once, where they rest
function paintStill(P) { if (night() && P.flies.length && (reduce.matches || !raf)) draw(P, 0, reduce.matches); }
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now;
  let any = false;
  for (const P of places) if (live(P) && P.flies.length) { draw(P, dt, false); any = true; }
  raf = any ? requestAnimationFrame(frame) : 0;
}
function wake() {
  for (const P of places) if (night()) loadMatte(P);
  if (reduce.matches) { if (raf) cancelAnimationFrame(raf), raf = 0; places.forEach(paintStill); return; }
  if (!raf && places.some((P) => live(P) && P.flies.length)) {
    // the first frame at once (inside the theme's crossfade, nothing of its own), then the loop
    last = performance.now();
    for (const P of places) if (live(P)) draw(P, 0, false);
    raf = requestAnimationFrame(frame);
  }
}

// the hero now; the footer once sections.html is in the page (index.html calls it again then)
export function scan() { PLACES.forEach(init); wake(); }
scan();
document.addEventListener('themechange', wake);
document.addEventListener('visibilitychange', wake);
reduce.addEventListener('change', wake);
