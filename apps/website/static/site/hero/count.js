// The live figures, counting up: the band under the hero (index.html) and $ANTS (sections.js).
// figures(box, sel) finds the figures in box and shows each at 70% of what it says (the last known value, never 0); when box comes into view (a third of it), once, they count up to what
// they say, fast then slowing hard at the end. A figure is its text: a number with its prefix and suffix ("19,252", "742.8B", "Epoch 30"),
// thousands and decimals as written. set(el, text) gives a figure a new value (a live one): before its count it waits for it, during
// it the count heads there instead, after it the text is just replaced. With reduced motion nothing counts: set only writes.
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MS = 2200;
const FROM = 0.7;   // a count starts at this share of its value: a figure never shows 0
const ease = (k) => (k >= 1 ? 1 : 1 - 2 ** (-10 * k));   // exponential ease-out: most of the way in the first third, then a long settle
const state = new WeakMap();   // el → { to, run, t0 }

function parse(text) {
  const m = text.match(/^(.*?)(\d[\d,]*(?:\.\d+)?)(.*)$/s);
  if (!m) return null;
  const [, pre, num, post] = m;
  return { pre, post, v: +num.replace(/,/g, ''), dec: (num.split('.')[1] || '').length, group: num.includes(',') || +num.replace(/,/g, '') >= 1e4 };
}
const show = (el, f, v) => { el.textContent = f.pre + v.toLocaleString('en-US', { minimumFractionDigits: f.dec, maximumFractionDigits: f.dec, useGrouping: f.group }) + f.post; };

function frame(now) {
  let more = false;
  for (const [el, s] of running) {
    const f = parse(s.to), k = Math.min(1, (now - s.t0) / MS);
    if (!f) { el.textContent = s.to; running.delete(el); continue; }
    if (k >= 1) { el.textContent = s.to; running.delete(el); s.done = true; continue; }
    show(el, f, s.from + (f.v - s.from) * ease(k)); more = true;
  }
  if (more) requestAnimationFrame(frame);
}
const running = new Map();

export function set(el, text) {
  const s = state.get(el);
  if (!s || s.done || still) { el.textContent = text; return; }
  s.to = text;   // waiting or counting: it ends there
  const f = parse(text);
  if (f && !s.t0) show(el, f, f.v * FROM);   // still waiting: it starts from 70% of the live value
}

export function figures(box, sel) {
  if (!box || still) return;
  const els = [...box.querySelectorAll(sel)];
  for (const el of els) {
    const f = parse(el.textContent);
    if (!f) continue;
    state.set(el, { to: el.textContent, done: false });
    show(el, f, f.v * FROM);
  }
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    io.disconnect();
    const t0 = performance.now();
    for (const el of els) { const s = state.get(el); if (!s) continue; s.t0 = t0; s.from = parse(el.textContent).v; running.set(el, s); }
    requestAnimationFrame(frame);
  }, { threshold: 0.33 });
  io.observe(box);
}
