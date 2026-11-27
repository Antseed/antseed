// effects/mosaic.js: the mosaic under the cursor. The site's hero/wash-led.js (17 Nov), algorithm, values and timings unchanged; what
// changed: it finds every .wash in the page that carries --wash (the site's #sections, less its network panel), data-effects keeps one
// out, the cells are read where the kit lays the painting (cover at --wash-pos, the site assumed the centre), the paper is the kit's
// --color-rail, and the site's switched-off copy of the dots onto glass windows is left out.
// Load it as a module at the end of <body> (DESIGN.md, Motion & Micro-interaction): <script type="module" src="effects/mosaic.js">.
//
// Where the pointer passes over a painting, the picture breaks up locally into an LED mosaic (colour "image", round tiles):
// round dots on a fixed 8px grid, each in its cell's own colour, the page's paper coming up round them toward the trail's heart, where a
// dot drops out here and there; at its edge the painting comes back cell by cell as flat squares. What the cursor lays is the lab's
// motion trail (a trail that keeps a share of itself each frame), laid by the pointer: 88px wide, fading by half every 0.3s, and the
// painting is whole again. Drawn on a canvas over the painting and under everything in the panel, so glass windows stay on top.
// A mouse only ((hover: hover), pointerType mouse: never touch or pen), never with prefers-reduced-motion: reduce, and not before the
// painting has arrived (effects/arrival.js: data-unveil until then). Day or night, it reads whichever painting is showing.
// The cells' colours are read from the painting's pixels: the page must be served over http(s) with the paintings on its own origin
// (file:// and other origins taint the canvas; the trail then never shows, without an error).
// 2D canvas rather than WebGL: the marks are a few hundred flat dots at most, coloured from one read of the painting at a cell a pixel;
// no GL context per panel, no shader to compile, nothing running between hovers.
// Opt a painting out with data-effects="none" (no effect) or data-effects="arrival" (the arrival only) on its .wash.
const root = document.documentElement;
const PITCH = 8;           // the grid, CSS px, as the arrival
const DOT = 0.42;          // a dot's radius, × the pitch
const RADIUS = 88;         // the cursor's reach, CSS px
const HALF_LIFE = 0.3;     // s: how fast the trail fades
const SQUARE = 0.46, ROUND = 0.5, PAPERED = 0.8, GONE = 1.06;   // the levels where a cell turns into a flat square, a dot (the paper coming up round it until PAPERED), bare paper
const PAPER = { light: '#ffffff', dark: '#181d1b' };   // the rail's paper, if --color-rail is missing
const hash = (x, y, s) => { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// value noise over the cells: the trail's ragged edge, as the lab's front (fbm of the place)
const vnoise = (x, y) => {
  const ix = Math.floor(x), iy = Math.floor(y), u = smooth(x - ix), v = smooth(y - iy), h = (a, b) => hash(a, b, 9);
  return (h(ix, iy) * (1 - u) + h(ix + 1, iy) * u) * (1 - v) + (h(ix, iy + 1) * (1 - u) + h(ix + 1, iy + 1) * u) * v;
};
// the lab's LED mosaic preset ("Hero → LED mosaic"): contrast 1.1, saturation 1.2
const adjust = (r, g, b) => {
  const c = [r, g, b].map((v) => Math.min(1, Math.max(0, (v / 255 - 0.5) * 1.1 + 0.5))), l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return c.map((v) => Math.round(Math.min(1, Math.max(0, l + (v - l) * 1.2)) * 255));
};
// night: antseed.js's data-theme on <html>; without it, the system's setting
const night = () => (root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
const takes = (el) => { const v = el.dataset.effects; return v == null || v.split(/\s+/).includes('mosaic'); };
// where the CSS lays a background along one axis: a share of the free room (50%), or px from the start
const place = (v, room) => { const m = /^(-?[\d.]+)(%|px)$/.exec(v || ''); return !m ? room / 2 : m[2] === '%' ? room * m[1] / 100 : +m[1]; };

const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;
const live = new Set(), images = new Map();
let queued = false, last = 0;
const load = (url) => {
  if (!images.has(url)) { const img = new Image(); img.src = url; images.set(url, img.decode().then(() => img)); }
  return images.get(url);
};

function panel(el) {
  const w = { el, c: null, ctx: null, key: '', cols: 0, rows: 0, dpr: 1, heat: null, jit: null, ink: null, ready: false, px: -1, py: -1, box: null };
  // the painting the panel shows (day or night), as the CSS lays it (cover at its background-position), read at one pixel a cell
  async function build() {
    const W = el.clientWidth, H = el.clientHeight, url = (getComputedStyle(el).backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1];
    if (!W || !H || !url) return;
    const key = `${url} ${W}x${H}`;
    if (key === w.key) return;     // the same painting at the same size
    w.key = key; w.ready = false;
    const img = await load(url).catch(() => null); if (!img || w.key !== key) return;
    const cols = Math.ceil(W / PITCH), rows = Math.ceil(H / PITCH), dpr = Math.min(2, devicePixelRatio || 1);
    if (!w.c) {
      w.c = Object.assign(document.createElement('canvas'), { className: 'wl', ariaHidden: 'true' });
      w.c.style.cssText = 'position:absolute;left:0;top:0;z-index:-1;pointer-events:none';    // over the painting, under everything in the panel (.wash isolates)
      el.prepend(w.c); w.ctx = w.c.getContext('2d');
      w.dc = document.createElement('canvas'); w.dctx = w.dc.getContext('2d');     // the dots alone, drawn over the paper and the squares
    }
    Object.assign(w, { cols, rows, dpr, heat: new Float32Array(cols * rows), box: null });
    w.dc.width = w.c.width = Math.round(cols * PITCH * dpr); w.dc.height = w.c.height = Math.round(rows * PITCH * dpr); w.c.style.width = `${cols * PITCH}px`; w.c.style.height = `${rows * PITCH}px`;
    // a cell's colour: the painting averaged over it, in two steps so the reduction stays even
    // cover at the panel's background-position (--wash-pos), unless it is drawn wider ("125% auto"), then where it is laid
    const cs = getComputedStyle(el), wide = cs.backgroundSize.match(/^([\d.]+)% auto$/), [ax, ay] = cs.backgroundPosition.split(',')[0].trim().split(/\s+/);
    let dw, dh;
    if (wide) { dw = W * wide[1] / 100; dh = dw * img.naturalHeight / img.naturalWidth; }
    else { const s = Math.max(W / img.naturalWidth, H / img.naturalHeight); dw = img.naturalWidth * s; dh = img.naturalHeight * s; }
    const dx = place(ax, W - dw), dy = place(ay, H - dh);
    const mid = Object.assign(document.createElement('canvas'), { width: cols * 4, height: rows * 4 }), m = mid.getContext('2d');
    m.imageSmoothingQuality = 'high'; m.drawImage(img, dx / PITCH * 4, dy / PITCH * 4, dw / PITCH * 4, dh / PITCH * 4);
    const one = Object.assign(document.createElement('canvas'), { width: cols, height: rows }), o = one.getContext('2d', { willReadFrequently: true });
    o.imageSmoothingQuality = 'high'; o.drawImage(mid, 0, 0, cols, rows);
    let d; try { d = o.getImageData(0, 0, cols, rows).data; } catch { return; }     // a tainted canvas (file://, another origin): no trail
    w.ink = []; w.jit = new Float32Array(cols * rows);
    const dark = night();
    for (let y = 0, n = 0; y < rows; y++) for (let x = 0; x < cols; x++, n++) {
      let [r, g, b] = adjust(d[n * 4], d[n * 4 + 1], d[n * 4 + 2]);
      if (dark) [r, g, b] = [r, g, b].map((v) => Math.round(v + (255 - v) * 0.12));     // at night the dots lit a little, as LEDs on the dark paper
      w.ink[n] = `rgb(${r},${g},${b})`;
      w.jit[n] = (hash(x, y, 3) - 0.5) * 0.22 + (vnoise(x / 5, y / 5) - 0.5) * 0.3;     // each cell's own step, and the ragged edge
    }
    w.paper = getComputedStyle(root).getPropertyValue('--color-rail').trim() || PAPER[dark ? 'dark' : 'light'];
    w.ready = true;
  }
  // the trail: from the last point to this one, a soft disc every half cell, the highest value kept
  function lay(x, y) {
    const R = RADIUS / PITCH, gx = x / PITCH, gy = y / PITCH;
    const fx = w.px < 0 ? gx : w.px, fy = w.px < 0 ? gy : w.py, steps = Math.max(1, Math.ceil(Math.hypot(gx - fx, gy - fy) * 2));
    w.px = gx; w.py = gy;
    for (let i = 1; i <= steps; i++) {
      const sx = fx + (gx - fx) * i / steps, sy = fy + (gy - fy) * i / steps;
      const x0 = Math.max(0, Math.floor(sx - R)), x1 = Math.min(w.cols - 1, Math.ceil(sx + R)), y0 = Math.max(0, Math.floor(sy - R)), y1 = Math.min(w.rows - 1, Math.ceil(sy + R));
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const dd = Math.hypot(cx + 0.5 - sx, cy + 0.5 - sy) / R; if (dd >= 1) continue;
        const n = cy * w.cols + cx, v = smooth(1 - dd);
        if (v > w.heat[n]) w.heat[n] = v;
      }
      const b = w.box || (w.box = [x0, y0, x1, y1]);
      b[0] = Math.min(b[0], x0); b[1] = Math.min(b[1], y0); b[2] = Math.max(b[2], x1); b[3] = Math.max(b[3], y1);
    }
    live.add(w); wake();
  }
  // a frame: the trail fades; each cell at its level is the painting, a flat square, a dot on the paper, or the paper alone
  w.draw = (fade) => {
    const { ctx, dctx, cols, heat, jit, ink, box, dpr } = w, p = PITCH * dpr, r = DOT * p;
    if (!box) return false;
    const [x0, y0, x1, y1] = box, bx = x0 * p, by = y0 * p, bw = (x1 - x0 + 1) * p, bh = (y1 - y0 + 1) * p;
    ctx.clearRect(bx, by, bw, bh); dctx.clearRect(bx, by, bw, bh);
    const paper = [new Path2D(), new Path2D(), new Path2D(), new Path2D()], squares = [], dots = [];
    let alive = false, nx0 = 1e9, ny0 = 1e9, nx1 = -1, ny1 = -1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const n = y * cols + x; let h = heat[n];
      if (h <= 0) continue;
      h *= fade; if (h < 0.02) h = 0; heat[n] = h;
      if (!h) continue;
      alive = true; nx0 = Math.min(nx0, x); ny0 = Math.min(ny0, y); nx1 = Math.max(nx1, x); ny1 = Math.max(ny1, y);
      const s = h + jit[n] * Math.min(1, h * 3);
      if (s < SQUARE) continue;
      if (s < ROUND) { squares.push(n); continue; }
      paper[Math.min(3, Math.floor(4 * (s - ROUND) / (PAPERED - ROUND)))].rect(x * p, y * p, p, p);     // the paper comes up round the dots, so the trail's edge scatters
      if (s < GONE) dots.push(n);
    }
    w.box = alive ? [nx0, ny0, nx1, ny1] : null;
    ctx.fillStyle = w.paper; paper.forEach((q, i) => { ctx.globalAlpha = (i + 1) / 4; ctx.fill(q); }); ctx.globalAlpha = 1;
    for (const n of squares) { ctx.fillStyle = ink[n]; ctx.fillRect((n % cols) * p, Math.floor(n / cols) * p, p, p); }
    for (const n of dots) { const x = (n % cols + 0.5) * p, y = (Math.floor(n / cols) + 0.5) * p; dctx.fillStyle = ink[n]; dctx.beginPath(); dctx.arc(x, y, r, 0, Math.PI * 2); dctx.fill(); }
    ctx.drawImage(w.dc, bx, by, bw, bh, bx, by, bw, bh);     // the dots over the paper and the squares
    return alive;
  };
  w.stop = () => {
    if (w.heat) w.heat.fill(0); if (w.ctx) { w.ctx.clearRect(0, 0, w.c.width, w.c.height); w.dctx.clearRect(0, 0, w.dc.width, w.dc.height); }
    w.box = null; w.px = -1; live.delete(w);
  };
  // a mouse only, and only once the panel has arrived (effects/arrival.js: data-unveil until then)
  const mouse = (e) => e.pointerType === 'mouse' && !el.dataset.unveil;
  el.addEventListener('pointerenter', (e) => { if (mouse(e)) build(); });
  el.addEventListener('pointermove', (e) => {
    if (!mouse(e)) return;
    if (!w.ready) { build(); return; }     // the theme changed under the pointer, or the painting is still loading
    const b = el.getBoundingClientRect(), k = b.width / el.offsetWidth || 1;
    lay((e.clientX - b.left) / k, (e.clientY - b.top) / k);
  }, { passive: true });
  el.addEventListener('pointerleave', () => { w.px = -1; });
  return w;
}

function frame(now) {
  queued = false;
  if (document.hidden) { for (const w of live) w.stop(); return; }
  const dt = Math.min(0.1, (now - (last || now)) / 1000), fade = 0.5 ** (dt / HALF_LIFE);
  last = now;
  for (const w of live) { const alive = w.draw(fade); if (!alive) live.delete(w); }
  if (live.size) wake(); else last = 0;
}
function wake() { if (!queued && live.size) { queued = true; requestAnimationFrame(frame); } }

if (!STILL && matchMedia('(hover: hover)').matches) {
  const all = [...document.querySelectorAll('.wash')].filter((el) => takes(el) && getComputedStyle(el).getPropertyValue('--wash').trim()).map(panel);
  const byElement = new Map(all.map((w) => [w.el, w]));
  // off screen, a trail ends at once
  const view = new IntersectionObserver((es) => { for (const e of es) if (!e.isIntersecting) byElement.get(e.target)?.stop(); });
  all.forEach((w) => view.observe(w.el));
  // a new theme shows the other painting, a new size another grid: the trail ends, and the painting is read again on the next move
  const reset = (w) => { w.stop(); w.key = ''; w.ready = false; };
  new MutationObserver(() => all.forEach(reset)).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  const sized = new ResizeObserver((es) => { for (const e of es) { const w = byElement.get(e.target); if (w?.key) reset(w); } });
  all.forEach((w) => sized.observe(w.el));
}
