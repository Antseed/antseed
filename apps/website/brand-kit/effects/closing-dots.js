// closing-dots.js: the closing band's dot field, ported from the site's own code (src/parts/CtaBand/CtaDots.tsx, gridLayout.ts and
// PrivacyDots/mosaic.ts) with the same files, grid and values. It draws the still mosaic into `.cta-card .tw`; the site's moving layer
// (twinkles, warm dots, ants) is not part of the kit. Load it at the end of <body>, as starter.html does:
//   <script type="module" src="effects/closing-dots.js"></script>
// The mosaic files ship in the kit at assets/dots/privacy-dots.svg and privacy-dots-dark.svg (one per theme).

const STEP = 16;            // the band's dot pitch (CtaBand.tsx GRID); antseed.js keeps the card a multiple of 16 tall
const DOT_RADIUS = 2.4;     // PrivacyDots/mosaic.ts
const MAX_DPR = 2;
const MOSAIC_COLS = 97, MOSAIC_ROWS = 54;               // the mosaic's size in its own cells
const MOSAIC_X0 = 7.2, MOSAIC_Y0 = 6.5, MOSAIC_STEP = 15.45;
const BASE = new URL('../assets/dots/', import.meta.url);

const cache = new Map();
function loadMosaic(night) {
  const url = new URL(night ? 'privacy-dots-dark.svg' : 'privacy-dots.svg', BASE).href;
  if (!cache.has(url)) {
    const p = fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(url + ': ' + r.status)))).then((svg) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      return [...doc.querySelectorAll('g')].map((g) => ({
        fill: g.getAttribute('fill') || '#000',
        dots: [...g.querySelectorAll('circle')].map((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]),
      }));
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}

// target cell k of n -> source cell in a mosaic m cells long (gridLayout.ts): first half from its start, the rest from its end;
// a box larger than the mosaic repeats its inner cells in the middle, so the frame stays whole at any size
function sourceCell(k, n, m) {
  const half = Math.floor(m / 2);
  if (n <= m) return k < Math.ceil(n / 2) ? k : m - (n - k);
  if (k < half) return k;
  if (n - k <= m - half) return m - (n - k);
  const q = Math.floor(m / 4);
  return q + ((k - half) % (m - 2 * q));
}

function draw(host, canvas, groups) {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cols = Math.floor(w / STEP), rows = Math.floor(h / STEP);
  const ox = (w - cols * STEP) / 2 + STEP / 2, oy = (h - rows * STEP) / 2 + STEP / 2;
  const groupAt = new Map();
  groups.forEach((g, gi) => {
    for (const [x, y] of g.dots) groupAt.set(Math.round((x - MOSAIC_X0) / MOSAIC_STEP) + ',' + Math.round((y - MOSAIC_Y0) / MOSAIC_STEP), gi);
  });
  const paths = groups.map((g) => ({ fill: g.fill, path: new Path2D() }));
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const gi = groupAt.get(sourceCell(i, cols, MOSAIC_COLS) + ',' + sourceCell(j, rows, MOSAIC_ROWS));
    if (gi === undefined) continue;
    const x = ox + i * STEP, y = oy + j * STEP;
    paths[gi].path.moveTo(x + DOT_RADIUS, y);
    paths[gi].path.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
  }
  for (const { fill, path } of paths) { ctx.fillStyle = fill; ctx.fill(path); }
}

for (const host of document.querySelectorAll('.cta-card .tw')) {
  const canvas = document.createElement('canvas');
  canvas.className = 'tw-dots';
  host.appendChild(canvas);
  let groups = null, token = 0;
  const night = () => document.documentElement.dataset.theme === 'dark';
  const load = () => {
    const mine = ++token;
    loadMosaic(night()).then((g) => { if (mine === token) { groups = g; draw(host, canvas, groups); } }, (e) => console.warn('closing band dots not drawn', e));
  };
  new ResizeObserver(() => { if (groups) draw(host, canvas, groups); }).observe(host);
  document.addEventListener('themechange', load);
  new MutationObserver(load).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  load();
}
