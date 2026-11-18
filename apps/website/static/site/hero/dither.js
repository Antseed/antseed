// The homepage's dither, loaded with the sections (index.html):
// 1. fine dither points at the edges of Whimsical 2's clouds, read from the film itself, in the painting's colours
// 3. the fine dots behind Private by design, which the cursor lights up and ants walk

// The sky: one canvas pixel per cell; dither.css masks each cell to a small round dot.
const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('dither.css', import.meta.url).href });
document.head.append(link);

const HERO_CELL = 2, TAU = Math.PI * 2, root = document.documentElement, STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;
// each cell's threshold: an R2 low-discrepancy sequence, even but with no order to line up. (A Bayer matrix, at these densities, draws little crosses.)
const thresholds = (cols, rows, phase = 0) => { const t = new Float32Array(cols * rows); for (let y = 0, n = 0; y < rows; y++) for (let x = 0; x < cols; x++) t[n++] = (x * 0.7548776662 + y * 0.569840291 + phase + 0.5) % 1; return t; };
const rng = (seed) => { let s = (seed * 48271 + 11) % 2147483647; const r = () => (s = (s * 16807) % 2147483647) / 2147483647; r(); r(); return r; };
const clamp = (v) => Math.min(1, Math.max(0, v)), dark = () => root.dataset.theme === 'dark';
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };

// ── 1. the sky ──
// Clusters of fine pale points on the clouds, read from the film itself and mixed from the paint under them. This film's clouds are
// nearly white on grained paper, so the points gather just around them and in their blue shadows, where they show, and the open sky stays clear.
// Under .night, so the dark theme tints them with the film.
const POSTER = '/site/assets/hero/video/whimsical-2-poster.webp', SKY_END = 0.5, HALO = 3, DENSITY = 0.72;     // SKY_END a share of the film's height where the points stop; HALO how far they gather round a cloud; DENSITY how full a cluster is

// a box blur of a w×h field into out, once across and once down
function blur(a, t, out, w, h, r) {
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w; let s = 0;
    for (let i = -r; i <= r; i++) s += a[o + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) { t[o + x] = s / n; s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += t[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / n; s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x]; }
  }
}

// where the sky's points may gather: soft irregular patches, a dozen cells across
function clusters(w, h) {
  const r = rng(7), out = new Float32Array(w * h);
  const octave = (size) => {
    const gw = Math.ceil(w / size) + 2, gh = Math.ceil(h / size) + 2, g = Float32Array.from({ length: gw * gh }, r);
    return (x, y) => {
      const fx = x / size, fy = y / size, ix = Math.floor(fx), iy = Math.floor(fy), tx = smooth(0, 1, fx - ix), ty = smooth(0, 1, fy - iy), at = (a, b) => g[b * gw + a];
      return (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
    };
  };
  const big = octave(15), small = octave(6);
  for (let y = 0, n = 0; y < h; y++) for (let x = 0; x < w; x++) out[n++] = smooth(0.5, 0.64, big(x, y) * 0.6 + small(x, y) * 0.4);
  return out;
}

function heroLayer(paint) {
  const v = paint.querySelector('video'), poster = Object.assign(new Image(), { src: POSTER }), content = paint.parentElement.querySelector('.content');
  const c = Object.assign(document.createElement('canvas'), { className: 'dz-hero', ariaHidden: 'true' }), ctx = c.getContext('2d');
  paint.insertBefore(c, paint.querySelector('.night'));
  c.style.transformOrigin = `50% ${paint.offsetHeight / 2}px`;   // the painting's centre, so it settles with the film as the hero arrives (index.html)
  const skySrc = document.createElement('canvas'), skyRead = skySrc.getContext('2d', { willReadFrequently: true });
  let cols = 0, rows = 0, TH, wave, mx = -1e4, my = -1e4, near = 0, over = false, seen = true, last = 0, queued = false, tick = 0;
  let skyRows = 0, sw = 0, sh = 0, skyBox, skyImg, skyPx, ST, SG, SC, SN, SW, CLUSTERS, skyD, skyMask, calmX, calmY;
  function build() {
    const nc = Math.ceil(paint.offsetWidth / HERO_CELL), nr = Math.ceil(paint.offsetHeight / HERO_CELL);
    if (!nc || !nr || (nc === cols && nr === rows)) return;
    // the film as the page lays it out: cover, centred across, from its top
    const w = paint.offsetWidth / HERO_CELL, h = paint.offsetHeight / HERO_CELL, s = Math.max(w / 1280, h / 714), dh = 714 * s;
    cols = nc; rows = nr; skyRows = Math.min(rows, Math.floor(dh * SKY_END));
    c.width = cols; c.height = skyRows; c.style.width = `${cols * HERO_CELL}px`; c.style.height = `${skyRows * HERO_CELL}px`; TH = thresholds(cols, skyRows); wave = new Float32Array(cols);
    // the sky drifts slowly: read cell by cell, but only every third frame
    sw = cols; sh = skyRows;
    skyBox = [(w - 1280 * s) / 2, 0, 1280 * s, dh];
    skySrc.width = sw; skySrc.height = sh; skyD = null;
    skyImg = ctx.createImageData(cols, skyRows); skyPx = new Uint32Array(skyImg.data.buffer);
    [ST, SG, SC, SN, SW] = Array.from({ length: 5 }, () => new Float32Array(sw * sh)); CLUSTERS = clusters(sw, sh);
    skyMask = Float32Array.from({ length: skyRows }, (_, y) => { const f = y / dh; return (0.3 + 0.7 * smooth(0, 0.2, f)) * (1 - smooth(0.4, SKY_END, f)); });     // gentler up where the sky deepens, gone before the hills
    calmX = new Float32Array(cols); calmY = new Float32Array(skyRows);
    clearing(); tick = 0;
    frame(performance.now());
  }
  // the sky keeps quiet behind the title and the install block
  function clearing() {
    const els = [...content.children]; if (!els.length || !cols) return;
    const left = Math.min(...els.map((e) => content.offsetLeft + e.offsetLeft)) - paint.offsetLeft, right = Math.max(...els.map((e) => content.offsetLeft + e.offsetLeft + e.offsetWidth)) - paint.offsetLeft;
    const top = Math.min(...els.map((e) => content.offsetTop + e.offsetTop)) - paint.offsetTop, bottom = Math.max(...els.map((e) => content.offsetTop + e.offsetTop + e.offsetHeight)) - paint.offsetTop;
    for (let x = 0; x < cols; x++) { const p = x * HERO_CELL; calmX[x] = 1 - smooth(0, 110, Math.max(left - p, p - right)); }
    for (let y = 0; y < skyRows; y++) { const p = y * HERO_CELL; calmY[y] = 1 - smooth(0, 70, Math.max(top - p, p - bottom)); }
  }
  // the clouds: bright and warm against the blue. The points want to be near one but not on its white, in clusters
  function readSky(film) {
    skyRead.drawImage(film, skyBox[0], skyBox[1], skyBox[2], skyBox[3]);
    skyD = skyRead.getImageData(0, 0, sw, sh).data;
    for (let i = 0, n = sw * sh; i < n; i++) {
      const r = skyD[i * 4], g = skyD[i * 4 + 1], b = skyD[i * 4 + 2];
      SC[i] = smooth(0.84, 0.92, (r * 0.3 + g * 0.59 + b * 0.11) / 255) * smooth(-0.12, -0.03, (r - b) / 255);
    }
    blur(SC, ST, SN, sw, sh, 2); blur(SC, ST, SW, sw, sh, 12);
    for (let i = 0, n = sw * sh; i < n; i++) SG[i] = clamp(SW[i] * (1 - SN[i]) * HALO) * CLUSTERS[i] * DENSITY;
  }
  function drawSky() {
    const RR = 90, RR2 = RR * RR;
    for (let y = 0, n = 0; y < skyRows; y++) {
      const m = skyMask[y], cy = calmY[y];
      for (let x = 0; x < cols; x++, n++) {
        const base = SG[n];
        skyPx[n] = 0;
        if (base <= 0) continue;
        const quiet = 1 - 0.55 * calmX[x] * cy;
        let w = base * m * wave[x] * quiet;
        if (near > 0.01) { const ex = x - mx, ey = y - my, dd = ex * ex + ey * ey; if (dd < RR2) w += 0.5 * near * (1 - dd / RR2) ** 2 * Math.min(1, base * 4) * quiet; }
        if (w <= TH[n]) continue;
        const i = n * 4, r = skyD[i], g = skyD[i + 1], b = skyD[i + 2];
        skyPx[n] = ((165 << 24) | ((b + (238 - b) * 0.7) << 16) | ((g + (251 - g) * 0.7) << 8) | (r + (255 - r) * 0.7)) >>> 0;
      }
    }
    ctx.putImageData(skyImg, 0, 0);
  }
  function frame(now) {
    const film = v && v.classList.contains('on') && v.readyState >= 2 ? v : poster.complete && poster.naturalWidth ? poster : null;
    if (!film || !cols) return;
    if (tick++ % 3 === 0 || !skyD) readSky(film);
    near += ((over ? 1 : 0) - near) * 0.32;
    const t = now / 1000;
    for (let x = 0; x < cols; x++) wave[x] = STILL ? 1 : 0.9 + 0.1 * Math.sin(x * 0.017 - t * 0.8) + 0.05 * Math.sin(x * 0.043 + t * 0.5);     // a breath of wind along the sky
    drawSky();
  }
  function loop(now) {
    queued = false;
    if (!seen || document.hidden || STILL) return;
    queued = true; requestAnimationFrame(loop);
    if (now - last >= 1000 / 12 && cols) { last = now; frame(now); }     // the film is drawn at 12 a second: no more is needed
  }
  const wake = () => { if (!queued && seen && !document.hidden && !STILL) { queued = true; requestAnimationFrame(loop); } };
  addEventListener('pointermove', (e) => {
    const b = paint.getBoundingClientRect(), s = b.width / paint.offsetWidth;      // the opening scales the card
    mx = (e.clientX - b.left) / s / HERO_CELL; my = (e.clientY - b.top) / s / HERO_CELL;
    over = e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom;
  }, { passive: true });
  root.addEventListener('pointerleave', () => { over = false; });
  new IntersectionObserver(([e]) => { seen = e.isIntersecting; wake(); }).observe(paint);
  document.addEventListener('visibilitychange', wake);
  new ResizeObserver(build).observe(paint);
  document.fonts.ready.then(clearing);
  poster.decode().then(() => frame(performance.now())).catch(() => {});
  build(); wake();
}


// the sky starts with the hero, and grows in

if (root.classList.contains('whimsical2') && !document.querySelector('#hero .paint .clouds')) heroLayer(document.querySelector('#hero .paint'));

// ── 3. the dots behind Private by design ──
// The the design mosaic (assets/home/privacy-dots.svg and its -dark: 13px round dots 15.45px apart, round the edges), drawn as Meadow · Mascot draws its
// own (index.html, ?mascot): one round dot to a cell, laid as it always was, its top from the top of the section, its bottom from the bottom, its sides between. One canvas
// holds it still; a second what moves: a few dots twinkling lime or nearly white, the dots the cursor warms, which linger and fade, and the ants.
// The ants are the Mascot's: smaller lime dots walking the same grid a cell at a time, mostly straight on, now and then turning, the dots they cross
// tinted for a moment behind them. They come in on the mosaic, wander, and after a while fade and come in elsewhere; they keep clear of the title.
// A click on the background calls the nearest ones: they head for it, mill about there a moment and go back to wandering.
const PRIV_STEP = 15.45, PRIV_R = 2.4, ANT_R = 1.9, PRIV_NEAR = 110;   // the dots small and delicate
const SIDE = 30 * PRIV_STEP;   // the side rows repeated down a tall box's middle: 30 rows of the mosaic's sides only (160 to 623 from the top)
const ANT_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]], ANT_INK = '#c8f53c', ANT_CALL = 720, ANT_CALLED = 6;
// opts.fit: the mosaic laid cell for cell on a grid of opts.step that fills the box edge to edge,
// its left and top columns and rows from the mosaic's left and top, its right and bottom from its right and bottom, so the frame is whole
// at any size, with one dot at most per cell and none of the band's offsets
// The mosaic is one file per theme (34 KB each). Only the theme on screen is fetched, once for the page however many bands draw it; the
// other the first time the theme changes; none on a page where nothing draws the dots.
const mosaics = {};
const mosaic = (night) => {
  const name = night ? 'privacy-dots-dark.svg' : 'privacy-dots.svg';
  return mosaics[name] ??= fetch(new URL(`/site/assets/home/${name}`, import.meta.url)).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${name}: ${r.status}`))))
    .then((svg) => [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('g')]
      .map((g) => ({ fill: g.getAttribute('fill'), dots: [...g.querySelectorAll('circle')].map((c) => [+c.getAttribute('cx'), +c.getAttribute('cy')]) })))
    .catch((err) => { delete mosaics[name]; throw err; });   // not kept: the next band, or the next theme change, asks again
};
async function privacyDots(sec, opts = {}) {
  const S = opts.step || PRIV_STEP;
  const tw = sec?.querySelector('.tw'); if (!tw) return;
  let night = dark(), groups = await mosaic(night);   // the mosaic drawn, and its theme
  const still = document.createElement('canvas'), live = document.createElement('canvas'), bg = still.getContext('2d'), fg = live.getContext('2d');
  tw.prepend(still, live);
  let W = 0, H = 0, n = 0, X, Y, HEAT, TH, tw8 = [], mx = -1e4, my = -1e4, over = false, seen = false, queued = false, last = 0;
  // the grid the ants walk: the mosaic's (X0, Y0 its offset; the bottom band, laid from the bottom, its own Y offset below the middle)
  let X0 = 0, Y0 = 0, YB = 0, COLS = 0, ROWS = 0, ants = [], quiet = null, call = null, onTile = new Set();
  const cx = (i) => X0 + i * S, cy = (j) => { const y = Y0 + j * S; return y > H / 2 ? y + YB : y; };
  function build() {
    W = tw.clientWidth; H = tw.clientHeight; if (!W || !H) return;
    const dpr = devicePixelRatio || 1, band = Math.max(160, 832 - H / 2), ox = W / 2 - 752, xs = [], ys = [];
    for (const c of [still, live]) { c.width = W * dpr; c.height = H * dpr; c.style.width = `${W}px`; c.style.height = `${H}px`; }
    bg.setTransform(dpr, 0, 0, dpr, 0, 0); fg.setTransform(dpr, 0, 0, dpr, 0, 0); bg.clearRect(0, 0, W, H);
    const one = (x, y, path) => { if (x < -PRIV_R || y < -PRIV_R || x > W + PRIV_R || y > H + PRIV_R) return; path.moveTo(x + PRIV_R, y); path.arc(x, y, PRIV_R, 0, TAU); xs.push(x); ys.push(y); };
    if (opts.fit) {
      const C = Math.floor(W / S), R = Math.floor(H / S), ox0 = (W - C * S) / 2 + S / 2, oy0 = (H - R * S) / 2 + S / 2;
      // a target cell's source in the mosaic (97 columns, 54 rows): the first half from its start, the rest from its end; a box larger than
      // the mosaic repeats its inner columns or rows in the middle
      const src = (k, N, M) => { const h = Math.floor(M / 2); if (N <= M) return k < Math.ceil(N / 2) ? k : M - (N - k);
        if (k < h) return k; if (N - k <= M - h) return M - (N - k); const q = Math.floor(M / 4); return q + ((k - h) % (M - 2 * q)); };
      const cell = new Map();
      groups.forEach((g, gi) => { for (const [x, y] of g.dots) cell.set(`${Math.round((x - 7.2) / 15.45)},${Math.round((y - 6.5) / 15.45)}`, gi); });
      const paths = groups.map(() => new Path2D());
      for (let i = 0; i < C; i++) for (let j = 0; j < R; j++) {
        const gi = cell.get(`${src(i, C, 97)},${src(j, R, 54)}`); if (gi === undefined) continue;
        const x = ox0 + i * S, y = oy0 + j * S; paths[gi].moveTo(x + PRIV_R, y); paths[gi].arc(x, y, PRIV_R, 0, TAU); xs.push(x); ys.push(y);
      }
      groups.forEach((g, gi) => { bg.fillStyle = g.fill; bg.fill(paths[gi]); });
    } else
    for (const g of groups) {
      const path = new Path2D();
      for (const [cx, cy] of g.dots) {
        if (cy < band) one(ox + cx, cy, path);
        if (832 - cy < band) one(ox + cx, H - (832 - cy), path);
        // a box taller than the mosaic (the whole section): its sides go on down the middle, so it stays one frame. A block of
        // the side rows (SIDE tall, a whole number of rows, on their grid) is repeated from the top band down to the middle and from the
        // bottom band up to it
        if (cy >= 160 && cy < 160 + SIDE) for (let y = cy; y < H / 2; y += SIDE) if (y >= band) one(ox + cx, y, path);
        if (cy >= 672 - SIDE && cy < 672) for (let y = H - (832 - cy); y >= H / 2; y -= SIDE) if (y < H - band) one(ox + cx, y, path);
      }
      bg.fillStyle = g.fill; bg.fill(path);
    }
    const r = rng(17);
    n = xs.length; X = Float32Array.from(xs); Y = Float32Array.from(ys); HEAT = new Float32Array(n); TH = Float32Array.from({ length: n }, () => r());
    tw8 = []; for (let i = 0; i < n; i++) if (r() < 0.02) { const d = 3 + r() * 3; tw8.push([i, d, r() * d, 0.6 + r() * 0.3, r() < 0.2]); }
    const mod = (v) => ((v % S) + S) % S, top = ys.findIndex((y) => y < H / 2), low = ys.findIndex((y) => y > H / 2);
    X0 = mod(xs[0]); Y0 = top >= 0 ? mod(ys[top]) : 0; YB = low >= 0 ? mod(ys[low] - Y0) : 0; if (YB > S / 2) YB -= S;
    if (opts.fit) { X0 = (W - Math.floor(W / S) * S) / 2 + S / 2; Y0 = (H - Math.floor(H / S) * S) / 2 + S / 2; YB = 0; }
    COLS = Math.floor((W - X0) / S) + 1; ROWS = Math.floor((H - Y0) / S) + 1;
    onTile = new Set(xs.map((x, k) => `${Math.round((x - X0) / S)},${Math.round((ys[k] - (ys[k] > H / 2 ? Y0 + YB : Y0)) / S)}`));   // the cells with a dot: the only ones a trail tints
    // where the ants keep clear: the eyebrow, the title and the line under it, with a margin
    const box = tw.getBoundingClientRect(), heads = [...sec.querySelectorAll('.s-eyebrow, .s-h2, .s-sub')].map((e) => e.getBoundingClientRect());
    quiet = heads.length ? { l: Math.min(...heads.map((h) => h.left)) - box.left - 40, r: Math.max(...heads.map((h) => h.right)) - box.left + 40,
      t: Math.min(...heads.map((h) => h.top)) - box.top - 32, b: Math.max(...heads.map((h) => h.bottom)) - box.top + 32 } : null;
    const want = Math.round(Math.min(10, Math.max(4, W * H / 160000)));   // a few ants, not a swarm: 8 on a laptop, 4 on a phone
    ants = Array.from({ length: want }, () => spawn(performance.now() - Math.random() * 20000));
    if (STILL) fg.clearRect(0, 0, W, H);
  }
  // an ant comes in on a dot of the mosaic, facing anywhere; it lives 18 to 40 s, then fades and comes in elsewhere
  function spawn(now) {
    const k = Math.floor(Math.random() * n), i = Math.round((X[k] - X0) / S), j = Math.round((Y[k] - (Y[k] > H / 2 ? Y0 + YB : Y0)) / S);
    return { i, j, pi: i, pj: j, t: 1, dur: 150, dir: Math.floor(Math.random() * 4), born: now, life: 18000 + Math.random() * 22000, path: [], goal: null, until: 0 };
  }
  const clearOf = (x, y) => { if (!quiet) return 1; const d = Math.max(quiet.l - x, x - quiet.r, quiet.t - y, y - quiet.b); return Math.min(1, Math.max(0, d / 28)); };
  // as the Mascot's ants: mostly on, sometimes a quarter turn; called, mostly toward the click; there, milling about it
  function step(a, now) {
    a.path.unshift([a.i, a.j]); if (a.path.length > 3) a.path.pop();
    a.pi = a.i; a.pj = a.j; a.t = 0;
    let d;
    if (a.goal && now < a.until) {
      const dx = a.goal[0] - a.i, dy = a.goal[1] - a.j, close = Math.abs(dx) + Math.abs(dy) <= 1;
      d = !close && Math.random() < 0.85 ? (Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3)) : Math.floor(Math.random() * 4);
      a.dur = close ? 160 + Math.random() * 80 : 70 + Math.random() * 30;
    } else {
      a.goal = null;
      d = Math.random() < 0.7 ? a.dir : (a.dir + (Math.random() < 0.5 ? 1 : 3)) % 4;
      a.dur = 120 + Math.random() * 80;
    }
    let ni = a.i + ANT_DIRS[d][0], nj = a.j + ANT_DIRS[d][1];
    if (ni < 0 || nj < 0 || ni >= COLS || nj >= ROWS) { d = (d + 2) % 4; ni = a.i + ANT_DIRS[d][0]; nj = a.j + ANT_DIRS[d][1]; }
    a.dir = d; a.i = Math.max(0, Math.min(COLS - 1, ni)); a.j = Math.max(0, Math.min(ROWS - 1, nj));
  }
  function frame(now) {
    queued = false;
    if (!seen || document.hidden || STILL || !n) return;
    wake();
    if (now - last < 32) return;
    const dt = Math.min(64, now - last); last = now;
    const t = now / 1000, lime = [new Path2D(), new Path2D(), new Path2D(), new Path2D()], white = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const dot = (x, y, a, w, r = PRIV_R) => { if (a < 0.05) return; const p = (w ? white : lime)[Math.min(3, Math.floor(a * 4))]; p.moveTo(x + r, y); p.arc(x, y, r, 0, TAU); };
    for (const [i, d, w, pk, wh] of tw8) { const ph = ((t + w) / d) % 1; dot(X[i], Y[i], pk * (ph < 0.24 ? ph / 0.24 : ph < 0.56 ? (0.56 - ph) / 0.32 : 0), wh); }
    // the cursor warms the dots round it, sparser toward the edge, a quarter lit at most; they cool slowly
    const R2 = PRIV_NEAR * PRIV_NEAR;
    for (let i = 0; i < n; i++) {
      if (over) { const dx = X[i] - mx, dy = Y[i] - my, dd = dx * dx + dy * dy; if (dd < R2 && (1 - Math.sqrt(dd) / PRIV_NEAR) ** 1.5 > TH[i] * 0.9) HEAT[i] = Math.max(HEAT[i], 0.45 * (1 - Math.sqrt(dd) / PRIV_NEAR) + 0.1); }
      if (HEAT[i] > 0.02) { dot(X[i], Y[i], HEAT[i], false); HEAT[i] *= 0.9; } else HEAT[i] = 0;
    }
    if (call) {
      const near = ants.map((a) => [a, Math.hypot(cx(a.i) - call.x, cy(a.j) - call.y)]).filter(([, d]) => d < ANT_CALL).sort((p, q) => p[1] - q[1]).slice(0, ANT_CALLED);
      const gi = Math.round((call.x - X0) / S), gj = Math.round((call.y - (call.y > H / 2 ? Y0 + YB : Y0)) / S);
      for (const [a] of near) { a.goal = [gi, gj]; a.until = now + 5000 + Math.random() * 1500; }
      call = null;
    }
    // the ants: a smaller lime dot sliding from cell to cell, eased; the cells just crossed tinted, fainter each step; in and out over a second
    const ink = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const put = (x, y, al) => { if (al < 0.06) return; const p = ink[Math.min(3, Math.floor(al * 4))]; p.moveTo(x + ANT_R, y); p.arc(x, y, ANT_R, 0, TAU); };
    ants = ants.map((a) => (now - a.born > a.life + 1000 ? spawn(now) : a));
    for (const a of ants) {
      a.t += dt / a.dur; if (a.t >= 1) step(a, now);
      const age = now - a.born, fade = Math.min(1, age / 1000, (a.life + 1000 - age) / 1000);
      if (fade <= 0) continue;
      const e = a.t * a.t * (3 - 2 * a.t), x = cx(a.pi) + (cx(a.i) - cx(a.pi)) * e, y = cy(a.pj) + (cy(a.j) - cy(a.pj)) * e;
      a.path.forEach(([i, j], k) => onTile.has(`${i},${j}`) && dot(cx(i), cy(j), fade * (0.3 - k * 0.09), false));
      put(x, y, fade * clearOf(x, y));
    }
    fg.clearRect(0, 0, W, H);
    for (const [paths, color] of [[lime, '#c8f53c'], [white, '#f4fbe2']]) { fg.fillStyle = color; paths.forEach((p, b) => { fg.globalAlpha = (b + 1) / 4; fg.fill(p); }); }
    // the ants over it all, with the Mascot's night glow
    fg.shadowColor = 'rgba(200, 245, 60, .55)'; fg.shadowBlur = 6; fg.fillStyle = ANT_INK;
    ink.forEach((p, b) => { fg.globalAlpha = (b + 1) / 4; fg.fill(p); });
    fg.shadowBlur = 0; fg.globalAlpha = 1;
  }
  function wake() { if (!queued && seen && !document.hidden && !STILL) { queued = true; requestAnimationFrame(frame); } }
  sec.addEventListener('pointermove', (e) => { const b = tw.getBoundingClientRect(); mx = e.clientX - b.left; my = e.clientY - b.top; over = true; }, { passive: true });
  sec.addEventListener('pointerleave', () => { over = false; });
  // a click on the background (not on a card, a link or the text) calls the ants
  sec.addEventListener('click', (e) => {
    if (e.target.closest('a, button, article, [role="tabpanel"], .s-h2, .s-sub')) return;
    const b = tw.getBoundingClientRect(); call = { x: e.clientX - b.left, y: e.clientY - b.top }; wake();
  });
  new IntersectionObserver(([e]) => { seen = e.isIntersecting; wake(); }).observe(sec);
  document.addEventListener('visibilitychange', wake);
  let size = '';
  new ResizeObserver(() => { const now = `${tw.clientWidth}x${tw.clientHeight}`; if (now !== size) { size = now; build(); } }).observe(tw);
  // a new theme: its mosaic (fetched the first time; until it is there the dots stay as they are), then the redraw
  const retheme = async () => { const now = dark(), m = await mosaic(now); if (now !== dark()) return; night = now; groups = m; build(); };
  const again = () => retheme().catch((err) => console.warn('privacy dots not redrawn', err));
  new MutationObserver(again).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  if (night !== dark()) again();   // it changed while the first mosaic was on its way
}

const below = () => { privacyDots(sections.querySelector('.s-priv')).catch((err) => console.warn('privacy dots not drawn', err)); };
const sections = document.getElementById('sections');
if (sections.children.length) below();
else new MutationObserver((_, o) => { if (sections.children.length) { o.disconnect(); below(); } }).observe(sections, { childList: true });

// the same field for other bands
export { privacyDots };
