/* Night fireflies on a canvas laid over a painting. Positions are in the painting's own pixels and mapped as the picture is fitted
   (cover at `fit`), so they hold at every size. Three depths: far points that barely drift, mid ones wandering slowly, and near ones
   that really fly (hovers, cruises, short darts), each blinking on its own rhythm and, when deep, passing behind the foreground plants
   (a matte cut from the painting). Glows are cached sprites. */

export type FlyKind = 'far' | 'mid' | 'near';
export type FlyGroup = {
  kind: FlyKind;
  /** How many, and how many on a phone-width canvas. */
  n: number;
  phoneN: number;
  /** Home band in painting pixels: rows, and optionally columns (default: the visible width). */
  y: [number, number];
  x?: [number, number];
  /** Glow diameter and peak opacity ranges. */
  d: [number, number];
  a: [number, number];
  /** Near flies only: the ellipse they roam freely round home. */
  roam?: [number, number];
};
export type FlyPlace = {
  seed: number;
  img: [number, number];
  fit: [number, number];
  groups: FlyGroup[];
  /** Foreground matte: its image and the painting row it starts at. */
  matte?: {src: string; top: number};
};

const INKS = ['#d8f070', '#d8f070', '#a6e05a', '#ffb347'];
const SPRITE = 64;
const MIN_GLOW = 7;        // CSS px: no glow drawn smaller, however small the painting
const PHONE = 640;         // narrower canvases get fewer flies
const MAX_DT = 0.05;

const rng = (s: number) => () => (s = (s * 16807) % 2147483647) / 2147483647;
const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const sprites = new Map<string, HTMLCanvasElement>();
function sprite(c: string): HTMLCanvasElement {
  const hit = sprites.get(c);
  if (hit) return hit;
  const cv = Object.assign(document.createElement('canvas'), {width: SPRITE, height: SPRITE});
  const g = cv.getContext('2d')!;
  const gr = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
  const a = (k: number) => c + Math.round(k * 255).toString(16).padStart(2, '0');
  gr.addColorStop(0, '#fff'); gr.addColorStop(0.12, c); gr.addColorStop(0.2, a(0.85)); gr.addColorStop(0.4, a(0.3));
  gr.addColorStop(0.7, a(0.08)); gr.addColorStop(1, a(0));
  g.fillStyle = gr; g.fillRect(0, 0, SPRITE, SPRITE);
  sprites.set(c, cv);
  return cv;
}

type Mode = 'hover' | 'cruise' | 'dart';
const MODES: Record<Mode, {dur: [number, number]; sp: [number, number]; next: [Mode, number][]}> = {
  hover: {dur: [0.8, 2.4], sp: [3, 9], next: [['cruise', 0.65], ['dart', 1]]},
  cruise: {dur: [1.2, 3.2], sp: [16, 34], next: [['hover', 0.5], ['dart', 0.8], ['cruise', 1]]},
  dart: {dur: [0.16, 0.34], sp: [95, 150], next: [['hover', 0.6], ['cruise', 1]]},
};

type Blink = {t: number; gap: number; rise: number; hold: number; fade: number; base: number};
type Fly = {
  kind: FlyKind; hx: number; hy: number; x: number; y: number; vx: number; vy: number; z: number; d: number; a: number;
  ink: HTMLCanvasElement; ph: number[]; fq: [number, number]; amp: number; blink: Blink; glow: number;
  rx: number; ry: number; th: number; mode: Mode; mt: number; sp: number; zf: number;
};

function nextBlink(f: Fly, r: () => number) {
  const b = f.blink;
  const far = f.kind !== 'near';
  b.gap = far ? 0.8 + r() * 3 : 0.3 + r() * 1.5; b.rise = far ? 0.5 + r() * 0.6 : 0.18 + r() * 0.25;
  b.hold = 0.1 + r() * (far ? 0.6 : 0.5); b.fade = far ? 1 + r() * 1.4 : 0.6 + r() * 0.9;
  b.base = far ? 0.3 + r() * 0.2 : 0.16 + r() * 0.12;
}

function glow(f: Fly, dt: number, r: () => number): number {
  const b = f.blink; b.t += dt;
  const cycle = b.gap + b.rise + b.hold + b.fade;
  if (b.t > cycle) { b.t -= cycle; nextBlink(f, r); }
  const t = b.t - b.gap;
  const e = t < 0 ? 0 : t < b.rise ? ss(0, b.rise, t) : t < b.rise + b.hold ? 1 : 1 - ss(0, b.fade, t - b.rise - b.hold);
  return b.base + (1 - b.base) * e;
}

// a heading that wanders smoothly, a speed set by the mode, a soft pull home once outside its ellipse
function fly(f: Fly, dt: number, t: number, r: () => number) {
  f.mt -= dt;
  if (f.mt <= 0) {
    const p = r();
    const m = MODES[f.mode].next.find(([, c]) => p <= c)![0];
    const M = MODES[m];
    f.mode = m; f.mt = M.dur[0] + (M.dur[1] - M.dur[0]) * r(); f.sp = M.sp[0] + (M.sp[1] - M.sp[0]) * r();
    if (m === 'dart') f.th += (r() < 0.5 ? -1 : 1) * (0.7 + r() * 1.5);
  }
  f.th += (f.mode === 'hover' ? 2.2 : 1.3) * (Math.sin(t * 0.9 + f.ph[0]) + 0.6 * Math.sin(t * 2.3 + f.ph[1])) * dt;
  const dx = (f.hx - f.x) / f.rx;
  const dy = (f.hy - f.y) / f.ry;
  const out = Math.hypot(dx, dy) - 1;
  if (out > 0) {
    let d = Math.atan2(dy * f.ry, dx * f.rx) - f.th; d = Math.atan2(Math.sin(d), Math.cos(d));
    f.th += d * Math.min(1, dt * (1.5 + 4 * out));
  }
  const bob = f.mode === 'hover' ? Math.sin(t * 3.1 + f.ph[2]) * 7 : 0;
  const k = 1 - Math.exp(-dt * (f.mode === 'dart' ? 10 : 3));
  f.vx += (Math.cos(f.th) * f.sp - f.vx) * k; f.vy += (Math.sin(f.th) * f.sp * 0.6 + bob - f.vy) * k;
  f.x += f.vx * dt; f.y += f.vy * dt;
  f.z = 0.5 + 0.5 * Math.sin(t * f.zf * 6.28 + f.ph[3]) * (0.7 + 0.3 * Math.sin(t * 0.37 + f.ph[0]));   // 0 in front of the plants, 1 behind
}

function spawn(place: FlyPlace, x0: number, x1: number, phone: boolean): Fly[] {
  const r = rng(place.seed);
  const flies: Fly[] = [];
  for (const g of place.groups) {
    const lo = g.x ? Math.max(x0, g.x[0]) : x0;
    const hi = g.x ? Math.min(x1, g.x[1]) : x1;
    const n = phone ? g.phoneN : g.n;
    const pad = (hi - lo) * 0.04;
    for (let i = 0; i < n; i++) {
      const hx = lo + pad + (hi - lo - 2 * pad) * (i + 0.15 + r() * 0.7) / n;   // each in its own share of the width
      const hy = g.y[0] + (g.y[1] - g.y[0]) * r() ** (g.kind === 'far' ? 1.4 : 1);
      const f: Fly = {kind: g.kind, hx, hy, x: hx, y: hy, vx: 0, vy: 0, z: 0, d: g.d[0] + (g.d[1] - g.d[0]) * r(), a: g.a[0] + (g.a[1] - g.a[0]) * r(),
        ink: sprite(INKS[Math.floor(r() * INKS.length)]), ph: [r() * 7, r() * 7, r() * 7, r() * 7], fq: [0.05 + r() * 0.08, 0.11 + r() * 0.12],
        amp: 0, blink: {t: -r() * 4, gap: 0, rise: 0, hold: 0, fade: 0, base: 0}, glow: 0, rx: 0, ry: 0, th: 0, mode: 'hover', mt: 0, sp: 6, zf: 0};
      if (g.kind === 'near') Object.assign(f, {rx: g.roam![0], ry: g.roam![1], th: r() * 6.28, mt: r() * 1.5, zf: 0.05 + r() * 0.05});
      else f.amp = g.kind === 'far' ? 3 + r() * 5 : 10 + r() * 14;
      nextBlink(f, r);
      flies.push(f);
    }
  }
  return flies;
}

export type Fireflies = {set: (s: {live: boolean; still: boolean}) => void; stop: () => void};

export function mountFireflies(cv: HTMLCanvasElement, place: FlyPlace): Fireflies {
  const g = cv.getContext('2d')!;
  let flies: Fly[] = [];
  let s = 1;
  let ox = 0;
  let oy = 0;
  let dpr = 1;
  let t = 0;
  let raf = 0;
  let last = 0;
  let live = false;
  let still = false;
  let matte: HTMLImageElement | null = null;
  const r = rng(place.seed * 31);
  let key = '';

  function layout() {
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const [IW, IH] = place.img;
    s = Math.max(w / IW, h / IH); ox = (w - IW * s) * place.fit[0]; oy = (h - IH * s) * place.fit[1];
    const x0 = Math.max(0, -ox / s);
    const x1 = Math.min(IW, (w - ox) / s);
    const phone = w < PHONE;
    const k = `${phone} ${Math.round(x0 / 2)} ${Math.round(x1 / 2)}`;   // re-placed only when the painting's visible columns change
    if (k !== key) { key = k; flies = spawn(place, x0, x1, phone); }
  }

  function draw(dt: number) {
    t += dt;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height);
    g.setTransform(s * dpr, 0, 0, s * dpr, ox * dpr, oy * dpr);
    const min = MIN_GLOW / s;
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    const put = (f: Fly, a: number, d: number, behind: boolean) => {
      if (a < 0.01) return;
      const R = Math.max(d, min) / 2;
      g.globalAlpha = Math.min(1, a); g.drawImage(f.ink, f.x - R, f.y - R, 2 * R, 2 * R);
      if (behind) { bx0 = Math.min(bx0, f.x - R); by0 = Math.min(by0, f.y - R); bx1 = Math.max(bx1, f.x + R); by1 = Math.max(by1, f.y + R); }
    };
    g.globalCompositeOperation = 'lighter';
    const front: [Fly, number, number][] = [];
    for (const f of flies) {
      if (still) { f.x = f.hx; f.y = f.hy; f.glow = f.kind === 'near' ? 0.6 : f.kind === 'mid' ? 0.45 : 0.35; f.z = 0; }
      else {
        f.glow = glow(f, dt, r);
        if (f.kind === 'near') fly(f, dt, t, r);
        else { f.x = f.hx + f.amp * Math.sin(t * f.fq[0] * 6.28 + f.ph[0]); f.y = f.hy + f.amp * 0.5 * Math.sin(t * f.fq[1] * 6.28 + f.ph[1]); }
      }
      const a = f.a * f.glow;
      if (f.kind !== 'near') { put(f, a, f.d, true); continue; }
      const back = matte ? ss(0.56, 0.72, f.z) : 0;
      const d = f.d * (1 - 0.25 * f.z);   // deeper, a little smaller
      put(f, a * back, d, true);
      front.push([f, a * (1 - back), d]);
    }
    // the matte cuts the ones behind, over just the part where they are
    if (matte && place.matte && bx1 > bx0) {
      const top = place.matte.top;
      const x0 = Math.max(0, Math.floor(bx0));
      const x1 = Math.min(place.img[0], Math.ceil(bx1));
      const y0 = Math.max(top, Math.floor(by0));
      const y1 = Math.min(top + matte.height, Math.ceil(by1));
      if (x1 > x0 && y1 > y0) {
        g.globalCompositeOperation = 'destination-out'; g.globalAlpha = 1;
        g.drawImage(matte, x0, y0 - top, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
        g.globalCompositeOperation = 'lighter';
      }
    }
    for (const [f, a, d] of front) put(f, a, d, false);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  }

  const frame = (now: number) => {
    draw(Math.min(MAX_DT, (now - last) / 1000 || 0)); last = now;
    raf = live && !still ? requestAnimationFrame(frame) : 0;
  };
  const ro = new ResizeObserver(() => { layout(); if (still || !raf) draw(0); });
  ro.observe(cv);
  layout();
  if (place.matte) {
    const im = new Image(); im.src = place.matte.src;
    im.decode().then(() => { matte = im; if (!raf) draw(0); }, () => {});
  }

  return {
    set(next) {
      ({live, still} = next);
      if (still) { cancelAnimationFrame(raf); raf = 0; draw(0); return; }
      if (live && !raf) { last = performance.now(); draw(0); raf = requestAnimationFrame(frame); }
      if (!live && raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    stop() { cancelAnimationFrame(raf); raf = 0; ro.disconnect(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); },
  };
}
