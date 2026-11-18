// How the network works, on the painted map (parts/net-map.html, net-map.css): parts.js calls default(slot) once the markup is in.
// One request, in the five steps of production's cards. While the board is on screen the steps follow one another, each STEP ms: the
// card opens that step (a bar filling by it), and the map plays it (SCRIPT): the states are words in the root's data-on that the CSS
// shows, the ant you are changes pose, and the request, the answer and the payment travel along the routes. A click (or the arrow keys)
// on a step plays it again and holds it HOLD ms. With reduced motion nothing travels: each step shows its end, the steps by click only.
const STEP = 6800, HOLD = 16000;
const ART = new URL('/site/assets/home/net/', import.meta.url).href;
// only the poses whose pupils drift apart (the ants' eyes are a little lost, never both on one point): not look, not send
const POSES = ['you-idle', 'receive', 'cheer'];

// each step: the states it starts from, then [ms, what] in order. '+w' / '-w' a state on or off, 'pose:p' your pose,
// 'hop:a' a piece hops, 'go:token:route[:back]:ms' a token travels a route (from you, or back to you)
const SCRIPT = {
  1: { from: [], pose: 'you-idle', at: [[250, '+dht'], [500, '+look'], [700, '+s1'], [1250, '+s2'], [1800, '+s3'],
    [2400, '+ra'], [2650, '+rb'], [2900, '+rc']] },
  2: { from: ['dht', 'quiet', 'look', 'ra', 'rb', 'rc'], pose: 'you-idle', at: [[300, '+pa'], [600, '+pb'], [900, '+pc'],
    [2200, '+pickb'], [2200, 'pose:cheer'], [2300, 'hop:b'], [3800, 'pose:you-idle']] },
  3: { from: ['rb', 'pb', 'pickb'], pose: 'you-idle', at: [[200, '+rtb'], [1200, 'go:bubble:rb:1100'], [2300, 'hop:b'],
    [2700, 'go:answer:rb:back:1100'], [3800, 'pose:receive'], [3800, 'hop:you']] },
  4: { from: ['rb', 'pb', 'pickb', 'rtb'], pose: 'receive', at: [[300, 'pose:you-idle'], [600, 'go:coin:rb:1500'], [2100, 'hop:b'],
    [2600, 'pose:cheer'], [4200, 'pose:you-idle']] },
  5: { from: ['rb', 'pb', 'pickb', 'rtb', 'ra', 'pa'], pose: 'you-idle', at: [[400, '+offb'], [1400, '+picka'], [1500, '+rta'],
    [2500, 'go:bubble:ra:1000'], [3500, 'hop:a'], [3800, 'go:answer:ra:back:1000'], [4800, 'pose:cheer'], [4800, 'hop:you']] },
};

const start = (root) => {
  if (!root || root.dataset.nmOn) return;
  root.dataset.nmOn = '1';
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const you = root.querySelector('.nm-you');
  const youImg = you.querySelector('img');
  const piece = { you, a: root.querySelector('[data-p="a"]'), b: root.querySelector('[data-p="b"]'), c: root.querySelector('[data-p="c"]') };
  const route = { ra: root.querySelector('#nm-ra'), rb: root.querySelector('#nm-rb') };
  const tok = { bubble: root.querySelector('.nm-bubble'), answer: root.querySelector('.nm-answer'), coin: root.querySelector('.nm-coin') };
  const svg = root.querySelector('.nm-svg');
  const dark = () => document.documentElement.dataset.theme === 'dark';
  const src = (p) => `${ART}ant-${p}-${dark() ? 'night' : 'day'}.webp`;
  for (const p of POSES) for (const t of ['day', 'night']) new Image().src = `${ART}ant-${p}-${t}.webp`;

  let cur = 1, t0 = 0, held = 0, seen = false, raf = 0, fired = 0, pose = 'you-idle';
  const on = new Set();
  const flights = [];
  const write = () => { root.dataset.on = [...on].join(' '); };
  const setPose = (p) => { pose = p; youImg.src = src(p); };
  const hop = (el) => { el.classList.remove('hop'); void el.offsetWidth; el.classList.add('hop'); };
  // a point along a route, in the board's units, as a share of the board
  const place = (el, path, k) => {
    const len = path.getTotalLength(), pt = path.getPointAtLength(len * k), vb = svg.viewBox.baseVal;
    el.style.left = `${pt.x / vb.width * 100}%`; el.style.top = `${pt.y / vb.height * 100}%`;
  };
  const act = (what, now) => {
    const [k, ...rest] = what.split(':');
    if (k[0] === '+') on.add(k.slice(1));
    else if (k[0] === '-') on.delete(k.slice(1));
    else if (k === 'pose') setPose(rest[0]);
    else if (k === 'hop') hop(piece[rest[0]]);
    else if (k === 'go' && !still) {
      const [name, r, a, b] = rest, back = a === 'back', ms = +(back ? b : a);
      const el = tok[name];
      flights.push({ el, path: route[r], back, t: now, ms });
      place(el, route[r], back ? 1 : 0); el.classList.add('go');
    }
    write();
  };

  // a step: its starting states, then its script, played from t0 (or all of it at once: instant)
  const show = (n, how) => {
    cur = n; fired = 0; t0 = performance.now(); flights.length = 0;
    const s = SCRIPT[n];
    root.dataset.step = String(n);
    root.classList.add('nm-now');
    on.clear(); s.from.forEach((w) => on.add(w)); write(); setPose(s.pose);
    Object.values(tok).forEach((el) => el.classList.remove('go'));
    if (how === 'instant') { s.at.forEach(([, w]) => { if (!w.startsWith('go') && !w.startsWith('hop')) act(w, t0); }); fired = s.at.length; }
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('nm-now')));
    tabs.forEach((t, i) => { const sel = i + 1 === n; t.setAttribute('aria-selected', String(sel)); t.tabIndex = sel ? 0 : -1; t.style.setProperty('--p', sel && (still || how === 'instant') ? 1 : 0); });
    if (how === 'key') tabs[n - 1].focus();
  };

  const tick = (now) => {
    raf = 0;
    if (!seen || document.hidden) return;
    const s = SCRIPT[cur], lt = now - t0;
    while (fired < s.at.length && s.at[fired][0] <= lt) act(s.at[fired++][1], now);
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i], k = Math.min(1, (now - f.t) / f.ms), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      place(f.el, f.path, f.back ? 1 - e : e);
      if (k >= 1) { f.el.classList.remove('go'); flights.splice(i, 1); }
    }
    const tab = tabs[cur - 1];
    if (now < held) tab.style.setProperty('--p', 1);
    else if (lt >= STEP) { show(cur % 5 + 1); }
    else tab.style.setProperty('--p', lt / STEP);
    raf = requestAnimationFrame(tick);
  };
  const run = () => { if (!raf && !still) raf = requestAnimationFrame(tick); };

  tabs.forEach((t, i) => {
    t.addEventListener('click', () => { held = performance.now() + HOLD; show(i + 1, still ? 'instant' : undefined); run(); });
    t.addEventListener('keydown', (e) => {
      const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: 4 }[e.key];
      if (to === undefined) return;
      e.preventDefault(); held = performance.now() + HOLD; show((to + 5) % 5 + 1, still ? 'instant' : 'key'); run();
    });
  });
  new IntersectionObserver(([e]) => { const was = seen; seen = e.isIntersecting; if (seen && !was) { show(cur); run(); } }, { threshold: 0.35 }).observe(root);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && seen) { show(cur); run(); } });
  const tint = () => {
    for (const i of root.querySelectorAll('img[data-dark]')) { i.dataset.light ||= i.getAttribute('src'); i.src = dark() ? i.dataset.dark : i.dataset.light; }
    setPose(pose);
  };
  tint(); document.addEventListener('themechange', tint);
  show(1, 'instant');
  // for captures: board.nmAt(step, ms) stops the loop and shows that moment of a step
  root.nmAt = (n, ms) => {
    seen = false; cancelAnimationFrame(raf); raf = 0; show(n); t0 = performance.now() - ms;
    const s = SCRIPT[n]; root.classList.add('nm-now');
    while (fired < s.at.length && s.at[fired][0] <= ms) { const [at, w] = s.at[fired++]; if (!w.startsWith('hop')) act(w, t0 + at); }
    const now = performance.now();
    for (let i = flights.length - 1; i >= 0; i--) { const f = flights[i], k = Math.min(1, (now - f.t) / f.ms); if (k >= 1) { f.el.classList.remove('go'); flights.splice(i, 1); } else place(f.el, f.path, f.back ? 1 - k : k); }
    tabs[n - 1].style.setProperty('--p', ms / STEP);
  };
};

export default (el) => start(el.matches?.('[data-nm]') ? el : el.querySelector('[data-nm]'));
