// The hero's painting arrives once, at load (Whimsical 2, the default; :root.veil from the head script): the pill, the title and the
// install block are there from the first frame, then the painting grows from the card's centre in an oval, its moving edge breaking into an
// LED matrix, as the shader lab's "LED mosaic" poster: round dots on a fixed grid, dense by the picture and scattering, dropping out
// further away; just inside the edge the painting comes in cell by cell. Drawn as a cover in the hero's own colour over the painting (film,
// night and fireflies included) with holes cut in it, so the dots show the painting itself, moving. At the end the cover is gone and the
// hero is exactly as before. Not with reduced motion, nor for still captures (the head script then never sets .veil).
const root = document.documentElement;
const paint = root.classList.contains('veil') && document.querySelector('#hero .paint');

const PITCH = 8;          // the grid, in CSS px
const DOT = 0.42;         // a dot's radius, × the pitch
const BAND = 0.34;        // the fringe's width, in the oval's units (1 reaches the card's corners)
const SOLID = 0.22;       // the inner part of the fringe where the painting comes in cell by cell
const DELAY = 100, DURATION = 1500;   // ms: it starts as soon as the title is up
const FADE = 0.55;        // the share of the arrival over which the painting inside the oval fades up from the hero's colour
const ease = (t) => 1 - (1 - t) ** 3;
const hash = (x, y, s) => { const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };

if (paint) {
  const fill = getComputedStyle(document.getElementById('hero')).backgroundColor;
  const w = paint.offsetWidth, h = paint.offsetHeight;
  const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(w * dpr), H = Math.round(h * dpr), p = PITCH * dpr;
  const canvas = Object.assign(document.createElement('canvas'), { className: 'hv', width: W, height: H, ariaHidden: 'true' });
  const g = canvas.getContext('2d'), r = DOT * p;
  const cells = [];
  for (let j = 0, rows = Math.ceil(H / p), cols = Math.ceil(W / p); j < rows; j++) for (let i = 0; i < cols; i++) {
    const cx = (i + 0.5) * p, cy = (j + 0.5) * p;
    cells.push({ x: i * p, y: j * p, d: Math.hypot((cx - W / 2) / (W / 2), (cy - H / 2) / (H / 2)) / Math.SQRT2, a: hash(i, j, 1), b: hash(i, j, 2) });
  }
  const draw = (f, t = 0) => {
    g.globalCompositeOperation = 'source-over'; g.fillStyle = fill; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.beginPath();
    const inner = f - BAND;
    if (inner > 0) g.ellipse(W / 2, H / 2, inner * W / Math.SQRT2, inner * H / Math.SQRT2, 0, 0, Math.PI * 2);
    for (const q of cells) {
      const e = (f - q.d) / BAND; if (e <= 0 || e >= 1.05) continue;
      if (e > 1 - SOLID && q.a < (e - 1 + SOLID) / SOLID) { g.rect(q.x, q.y, p, p); continue; }   // the painting, cell by cell
      if (e < 1 && q.b <= Math.pow(e, 1.6)) { g.moveTo(q.x + p / 2 + r, q.y + p / 2); g.arc(q.x + p / 2, q.y + p / 2, r, 0, Math.PI * 2); }   // a dot
    }
    g.fill();
    // the fade: inside the oval a veil of the hero's colour that thins away, so the painting comes up faded as it grows
    const veil = 1 - Math.min(1, t / FADE);
    if (veil > 0 && f > 0) {
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 0.85 * veil * veil; g.fillStyle = fill; g.beginPath();
      g.ellipse(W / 2, H / 2, f * W / Math.SQRT2, f * H / Math.SQRT2, 0, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    }
  };
  draw(0); paint.append(canvas); root.classList.remove('veil');   // the cover takes over from the CSS one, in the same colour
  // the painting under the cover ready first (its poster, the film over it plays when it can), never more than half a second
  const poster = /url\(\s*['"]?([^'")]+)/.exec(getComputedStyle(paint).backgroundImage)?.[1], img = new Image();
  if (poster) img.src = poster;
  Promise.race([poster ? img.decode().catch(() => {}) : null, new Promise((ok) => setTimeout(ok, 500))]).then(() => setTimeout(() => {
    const t0 = performance.now();
    root.style.setProperty('--arrive', `${DURATION}ms`); root.classList.add('arriving');
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / DURATION);
      draw(ease(t) * (1 + BAND + 0.02), t);
      if (t < 1) requestAnimationFrame(frame); else { canvas.remove(); root.classList.remove('arriving'); }
    };
    requestAnimationFrame(frame);
  }, DELAY));
}
