// The footer's two awake ants watch the pointer. Over the meadow's film (footer.css, night-loop.js) each of their four eyes
// is drawn again from the After Effects kit (assets/home/footer/eyes: make-atlas.py, eyes.json): the eye's white without its pupil, which
// covers the film's eye up to its painted outline, the pupil over it, kept to the white, then the lid. At rest each pupil is where the
// painting has it, so the layer can't be told from the film; the pupils ease toward the pointer, each in its own ellipse, the two of one
// ant together, and back to the painted place when the pointer leaves the window. The blinks are the film's own, replayed on its clock
// (the white hides the film's). One set by day, one by night, each right over its own film and switched with it: at once, inside the
// page's crossfade (the view transition), with nothing of its own. Both sets are kept current all the time, so the crossfade finds the
// other theme's eyes where they are. The switch's own film (video.shift, night-loop.js) plays over both, its ants looking as painted, so
// while it plays (.shifting) the pupils go back to their painted place under it and come out of it from there.
// Only with a mouse (a fine pointer that hovers) and without reduced motion; elsewhere, the film alone. Runs only while the footer is on
// screen.
const root = document.documentElement;
const scene = document.querySelector('.s-foot.meadow .scene');
const fine = matchMedia('(hover: hover) and (pointer: fine)'), reduce = matchMedia('(prefers-reduced-motion: reduce)');
const ANTS = [['ant1-left', 'ant1-right'], ['ant3-left', 'ant3-right']];
const REACH = 300;    // px from the ant at which its pupils go all the way
const EASE = 0.15;    // of the way per 60th of a second
const DIR = new URL('/site/assets/home/footer/eyes/', import.meta.url);

if (scene) {
  let kit;                  // eyes.json, once the footer nears
  const sets = {};          // day, night: { el, frame, video, ants: [[x, y] in the film], eyes: [{ ant, k, pupil, lid, lids, blinks, state, t }] }
  const look = ANTS.map(() => ({ x: 0, y: 0, w: 0 }));   // per ant: where it looks (-1 to 1 in its eyes' ellipses), how much (0: at rest)
  let px = 0, py = 0, here = false, near = false, seen = false, started = false, raf = 0, last = 0;
  const on = () => fine.matches && !reduce.matches;

  // a set's layer: .eyes (the scene's box, so the night's is in the sweep's mask) > .frame (the film's box as it is fitted) > one <i> an eye,
  // put in the page only once its sheet is decoded
  const build = async (theme) => {
    const J = await kit, K = J[theme], [VW, VH] = J.video, [SW, SH] = K.sheetSize, src = new URL(K.sheet, DIR).href;
    const sheet = new Image(); sheet.src = src;
    await sheet.decode();
    const el = document.createElement('div'); el.className = `eyes ${theme}`;
    const frame = el.appendChild(document.createElement('div')); frame.className = 'frame';
    const ants = ANTS.map(() => [0, 0]);
    const eyes = Object.entries(K.eyes).map(([name, k]) => {
      const [x, y, w, h] = k.box, [iw, ih] = k.size, ant = ANTS.findIndex((a) => a.includes(name));
      ants[ant][0] += (x + w * k.center[0]) / 2; ants[ant][1] += (y + h * k.center[1]) / 2;
      const pos = ([cx, cy]) => `${(cx / (SW - iw)) * 100}% ${(cy / (SH - ih)) * 100}%`;   // a cell of the sheet, scaled to the eye's box
      const i = frame.appendChild(document.createElement('i'));
      i.style.cssText = `left:${(x / VW) * 100}%;top:${(y / VH) * 100}%;width:${(w / VW) * 100}%;height:${(h / VH) * 100}%;` +
        `--sheet:url("${src}");--size:${(SW / iw) * 100}% ${(SH / ih) * 100}%;--white:${pos(k.cells[0])};--pupil:${pos(k.cells[1])}`;
      i.innerHTML = '<b class="white"></b><b class="iris"><b class="pupil"></b></b><b class="lid"></b>';
      const blinks = new Array(J.frames).fill(0);
      for (const [f, s] of Object.entries(k.blink)) blinks[+f] = s;
      return { ant, k, pupil: i.querySelector('.pupil'), lid: i.querySelector('.lid'), lids: k.cells.slice(2).map(pos), blinks, state: 0, t: '' };
    });
    // each right over its own film: the day's under the night's still, the night's over its film and under the switch's film
    const video = scene.querySelector(`video.${theme}`);
    if (video) video.after(el); else scene.append(el);
    sets[theme] = { el, frame, video, ants, eyes, frames: J.frames, fps: J.fps };
    clock(video);
    wake();
  };

  // the film's frame on screen: the one it last handed the compositor where the browser says, else its clock
  const clock = (v) => {
    if (!v || !('requestVideoFrameCallback' in v)) return;
    const shown = (now, meta) => { v.shown = meta.mediaTime; v.requestVideoFrameCallback(shown); };
    v.requestVideoFrameCallback(shown);
    v.addEventListener('seeking', () => { v.shown = undefined; });
  };
  const frameOf = (s) => {
    const v = s.video;
    if (!v) return 0;
    const f = v.shown !== undefined ? Math.round(v.shown * s.fps) : Math.floor(v.currentTime * s.fps + 1e-3);
    return ((f % s.frames) + s.frames) % s.frames;
  };

  const tick = (now) => {
    raf = 0;
    if (!seen || !on()) return;
    raf = requestAnimationFrame(tick);
    const live = [sets.day, sets.night].filter(Boolean);   // both, the other theme's masked out (footer.css), ready for any switch
    if (!live.length) { last = 0; return; }
    const k = 1 - Math.pow(1 - EASE, (last ? Math.min(now - last, 100) : 16.7) / 16.7); last = now;
    // where the film is on screen (the same box for both): one read, before any write
    const r = live[0].frame.getBoundingClientRect(), sx = r.width / 1920, sy = r.height / 1080;
    const away = !here || scene.classList.contains('shifting');
    look.forEach((L, a) => {
      if (away) { L.w -= L.w * k; if (L.w < 1e-3) L.w = 0; return; }
      const [ax, ay] = live[0].ants[a], dx = px - (r.left + ax * sx), dy = py - (r.top + ay * sy);
      const d = Math.hypot(dx, dy) || 1, m = Math.min(1, d / REACH), tx = (dx / d) * m, ty = (dy / d) * m;
      if (L.w < 0.01) { L.x = tx; L.y = ty; }   // from rest, straight to where it looks
      else { L.x += (tx - L.x) * k; L.y += (ty - L.y) * k; }
      L.w += (1 - L.w) * k; if (L.w > 0.999) L.w = 1;
    });
    for (const s of live) {
      const f = frameOf(s);
      for (const e of s.eyes) {
        // the pupil from its painted place toward where its ant looks, inside its ellipse; a share of the eye's box
        const L = look[e.ant], { rest, travel } = e.k;
        const t = `translate(${(L.w * (travel[0] * L.x - rest[0]) * 100).toFixed(2)}%, ${(L.w * (travel[1] * L.y - rest[1]) * 100).toFixed(2)}%)`;
        if (t !== e.t) e.pupil.style.transform = e.t = t;
        const st = e.blinks[f];
        if (st !== e.state) {
          e.state = st;
          if (st) e.lid.style.backgroundPosition = e.lids[st - 1];
          e.lid.style.opacity = st ? 1 : 0;
        }
      }
    }
  };
  function wake() { if (!raf && seen && on()) { last = 0; raf = requestAnimationFrame(tick); } }

  const apply = () => {
    scene.classList.toggle('eyed', on());
    if (!on()) return;
    if (near && !started) {
      started = true;
      // the set on screen first, then the other, so that a theme flip finds it ready
      const first = root.dataset.theme === 'dark' ? 'night' : 'day';
      kit = fetch(new URL('eyes.json', DIR)).then((r) => r.json());
      build(first).then(() => build(first === 'day' ? 'night' : 'day')).catch(() => {});
    }
    wake();
  };

  new IntersectionObserver(([e]) => { near = e.isIntersecting; apply(); }, { rootMargin: '400px 0px' }).observe(scene);
  new IntersectionObserver(([e]) => { seen = e.isIntersecting; apply(); }).observe(scene);
  addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') return; px = e.clientX; py = e.clientY; here = true; wake(); }, { passive: true });
  addEventListener('pointerout', (e) => { if (!e.relatedTarget) here = false; }, { passive: true });   // out of the window
  addEventListener('blur', () => { here = false; });
  fine.addEventListener('change', apply); reduce.addEventListener('change', apply);
}
