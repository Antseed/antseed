// The Providers' two cards move. Each card's painting stays its poster (the panel's --wash, --wash-d): the still with reduced
// motion, for ?still and ?demo captures, and until its film can play. Over it, one looping film per card and theme (assets/home/providers,
// WebM where it plays, else MP4), whose first frame is the poster, so the film takes over with nothing to see. Each moving thing was
// animated on its own and the scene put back together (art/round3/providers):
// - the stall: the clean painting without its ant or its price board, the leaves from an image-to-video take, the screen's soft
//   flicker (and the lantern's at night); over it the board, swung on its nail in CSS (.pv-sign); the ant on top, cut from the painting
//   with its pupils painted out, and its pupils drawn over the whites, easing toward the pointer and back to where they were painted when it leaves (a mouse only);
// - the colony: each ant animated alone and put back in its place, the loops offset so the scene never pulses as one.
// Day and night each have their film; the one of the theme showing plays, only while the card is on screen. A theme flip swaps them at
// once, inside the page's crossfade (theme.js), with nothing of its own: the other theme's film is fetched once the first one plays.
const root = document.documentElement;
const q = new URLSearchParams(location.search);
const reduce = matchMedia('(prefers-reduced-motion: reduce)'), fine = matchMedia('(hover: hover) and (pointer: fine)');
const STILL = () => reduce.matches || q.has('still') || q.has('demo');
const REACH = 260;    // px from the ant at which its pupils go all the way
const EASE = 0.12;    // of the way per 60th of a second

const themeOf = () => (root.dataset.theme === 'dark' ? 'night' : 'day');
// Safari (and every iPhone browser, WebKit underneath) gets the MP4: it may say it can play the WebM and then never load it
const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Android|Edg/.test(navigator.userAgent);
const ext = (v) => (!webkit && v.canPlayType('video/webm; codecs="vp9"') ? 'webm' : 'mp4');

for (const live of document.querySelectorAll('.s-paths .pv-live')) {
  const panel = live.parentElement;
  const sets = Object.fromEntries([...live.querySelectorAll('.pv-set')].map((el) => [el.dataset.set, {
    name: el.dataset.set, el, video: el.querySelector('video'), imgs: [...el.querySelectorAll('img[data-src]')], ready: null,
  }]));
  let seen = false, near = false, eyes = null;

  // a set is shown once its film has a frame and its ant (if any) is decoded: frame 0 and the ant over it are the poster
  const load = (s) => {
    if (s.ready) return s.ready;
    s.video.preload = 'auto';
    s.video.src = `${s.video.dataset.src}.${ext(s.video)}`;
    const film = new Promise((ok) => { s.video.addEventListener('loadeddata', ok, { once: true }); s.video.addEventListener('canplay', ok, { once: true }); });
    s.video.load();
    // an iPhone loads nothing until asked to play: a muted inline play starts it, and the set not wanted now is paused again
    s.video.play()?.then(() => { if (!(seen && !STILL() && themeOf() === s.name)) s.video.pause(); }).catch(() => {});
    const art = s.imgs.map((i) => { i.src = i.dataset.src; return i.decode().catch(() => {}); });
    s.ready = Promise.all([film, ...art]).then(() => s.el.classList.add('on'));
    return s.ready;
  };
  const sync = () => {
    const now = themeOf(), go = seen && !STILL();
    live.classList.toggle('run', go);   // the board swings only while the card is seen
    for (const [name, s] of Object.entries(sets)) {
      if (go && name === now) {
        load(s).then(() => {
          if (seen && !STILL() && themeOf() === name) s.video.play().catch(() => {});
          // the other theme, held ready for a flip
          for (const [n2, o] of Object.entries(sets)) if (n2 !== name) load(o);
        });
      } else if (!s.video.paused) s.video.pause();
    }
  };
  new IntersectionObserver(([e]) => { near = e.isIntersecting; if (near && !STILL()) load(sets[themeOf()]); }, { rootMargin: '600px 0px' }).observe(panel);
  new IntersectionObserver(([e]) => { seen = e.isIntersecting; sync(); eyes?.wake(); }).observe(panel);
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  reduce.addEventListener('change', sync);

  // the stall ant's eyes: each pupil a box the size of its white (CSS), moved by a share of it; at rest where the painting has it
  const eyeEls = [...live.querySelectorAll('.pv-eye')];
  eyes = eyeEls.length ? (() => {
    const pupils = eyeEls.map((e) => ({ b: e.querySelector('b'), rest: e.dataset.rest.split(' ').map(Number), travel: e.dataset.travel.split(' ').map(Number), t: '' }));
    const L = { x: 0, y: 0, w: 0 };
    let px = 0, py = 0, here = false, raf = 0, last = 0;
    const on = () => fine.matches && !STILL();
    const tick = (now) => {
      raf = 0;
      if (!seen || !on()) return;
      const k = 1 - Math.pow(1 - EASE, (last ? Math.min(now - last, 100) : 16.7) / 16.7); last = now;
      if (!here) { L.w -= L.w * k; if (L.w < 1e-3) L.w = 0; }
      else {
        // from between the two eyes (the first set's boxes; both themes share them)
        const a = eyeEls[0].getBoundingClientRect(), b = eyeEls[1].getBoundingClientRect();
        const cx = (a.left + a.right + b.left + b.right) / 4, cy = (a.top + a.bottom + b.top + b.bottom) / 4;
        const dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy) || 1, m = Math.min(1, d / REACH), tx = (dx / d) * m, ty = (dy / d) * m;
        if (L.w < 0.01) { L.x = tx; L.y = ty; } else { L.x += (tx - L.x) * k; L.y += (ty - L.y) * k; }
        L.w += (1 - L.w) * k; if (L.w > 0.999) L.w = 1;
      }
      for (const p of pupils) {
        const x = p.rest[0] + L.w * (p.travel[0] * L.x - p.rest[0]), y = p.rest[1] + L.w * (p.travel[1] * L.y - p.rest[1]);
        const t = `translate(${(x * 100).toFixed(2)}%, ${(y * 100).toFixed(2)}%)`;
        if (t !== p.t) p.b.style.transform = p.t = t;
      }
      if (here || L.w) raf = requestAnimationFrame(tick); else last = 0;
    };
    const wake = () => { if (!raf && seen && on()) raf = requestAnimationFrame(tick); };
    addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') return; px = e.clientX; py = e.clientY; here = true; wake(); }, { passive: true });
    addEventListener('pointerout', (e) => { if (!e.relatedTarget) { here = false; wake(); } }, { passive: true });   // out of the window
    addEventListener('blur', () => { here = false; wake(); });
    return { wake };
  })() : null;
}
