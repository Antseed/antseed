// Antseed homepage below the hero: what moves. Runs once sections.html is in the page (hero/index.html loads it).
// 1. every section snapped to 8px high; blocks rising into view, counters, the price list's four media (models.json), its rows and bars,
//    the terminal typing,
//    each played once when it scrolls into view (none of it with reduced motion: then everything is at its end from the start)
//    (the network's diagram is net.js, mounted at the end)
// 2. the live routing window: a request every few seconds, from one of your tools to the provider that served it,
//    and the Provide AI tab
// 3. the theme switch in the footer: System, Light or Dark, through window.antseedTheme (the head script in index.html)
const root = document.querySelector('.s-page');
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

// once in view (a fifth of it on screen), run fn; with reduced motion it runs straight away and should jump to the end
function onView(els, fn, threshold = 0.2) {
  const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); fn(e.target); } }), { threshold });
  els.forEach((el) => io.observe(el));
}

// ── every section a multiple of 8px high ─────────────────────────────────
// so each section's top, and its dotted line, lands on a row of the margin's dots (sections.css), whatever the width and the open answer
const snap = (sec) => {
  sec.style.minHeight = '';
  const h = sec.getBoundingClientRect().height, to = Math.ceil(h / 8 - 0.02) * 8;
  if (to > h) sec.style.minHeight = to + 'px';
};
const snapRo = new ResizeObserver((entries) => entries.forEach((e) => snap(e.target)));
root.querySelectorAll('.s-sec').forEach((sec) => snapRo.observe(sec));
// a section measured before its stylesheet or fonts landed can be too tall, and its min-height would then hold it there: measure them all again once they have
const snapAll = () => root.querySelectorAll('.s-sec').forEach(snap);
document.querySelectorAll('#sections link[rel="stylesheet"]').forEach((link) => { if (!link.sheet) link.addEventListener('load', snapAll, { once: true }); });
document.fonts.ready.then(snapAll);

// ── 1. coming into view ──────────────────────────────────────────────
// a CSS cubic-bezier as a function of time, solved for t by bisection as the browser does, and one rAF loop shared by every tween,
// running only while one is
function bezier(x1, y1, x2, y2) {
  const at = (a, b, t) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x) => { let lo = 0, hi = 1, t = x; for (let n = 0; n < 20; n++) { t = (lo + hi) / 2; if (at(x1, x2, t) < x) lo = t; else hi = t; } return at(y1, y2, t); };
}
const easeOut = bezier(.16, 1, .3, 1);   // fast, then slowing: the price bars' curve in sections.css
const tweens = new Set();
const frame = (now) => {
  tweens.forEach((tw) => { const k = Math.min(1, Math.max(0, (now - tw.t0) / tw.ms)); tw.fn(k); if (k === 1) { tweens.delete(tw); tw.done(); } });
  if (tweens.size) requestAnimationFrame(frame);
};
const tween = (ms, fn) => new Promise((done) => { if (!tweens.size) requestAnimationFrame(frame); tweens.add({ t0: performance.now(), ms, fn, done }); });

// a big figure counts up from 0 to the number it shows (data-count, with data-prefix, data-suffix, data-group for thousands and
// data-dec for decimals), then is given back its own text. While it counts, its final text sits under it, hidden (.tally in
// sections.css), so it is as wide from the first frame and nothing beside it moves
const fmt = (el, v) => {
  const dec = +el.dataset.dec || 0;
  return (el.dataset.prefix || '') + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: !!el.dataset.group }) + (el.dataset.suffix || '');
};
const counters = new Map();   // element → start
if (!still) root.querySelectorAll('[data-count]').forEach((el) => {
  const end = el.textContent, to = +el.dataset.count, tally = document.createElement('span'), ghost = document.createElement('span'), run = document.createElement('span');
  tally.className = 'tally'; ghost.textContent = end; run.textContent = fmt(el, 0);
  tally.append(ghost, run); el.replaceChildren(tally);
  counters.set(el, () => tween(1800, (k) => { run.textContent = fmt(el, to * easeOut(k)); }).then(() => { el.textContent = end; }));
});

// each section's head (eyebrow, title, sub), then its big panel, then the rest, rise and fade in as they scroll into view. Each block is
// marked data-rv ("panel" for the big ones, which also grow from .98) and .s-page gets .rv: sections.css hides them only then. Those
// that come in together get --i, their place in the batch, for a 50ms stagger; once in, the marks come off
const HEAD = '.s-pixel, .s-lede > p, .s-eyebrow, .s-h2, .s-h3, .s-head > .s-sub, .s-duo-head > .s-sub, .s-priv .s-center > .s-sub';
const PANEL = '.s-duo-panel, .s-lr-panel, .s-net-panel, .s-pv-stage';
const BODY = '.s-media, .s-link, .s-feats li, .s-duo-text .s-actions, .s-get .s-narrow, .s-cards article, .s-pv-list, '
  + '.qs details, .s-foot .cols > *, .s-foot .legal';   // the network's three points come in with micro.js
const STEP = 50;
const rv = new IntersectionObserver((entries) => {
  let k = 0;
  entries.forEach((e) => {
    if (!e.isIntersecting) return;
    const el = e.target, i = Math.min(k++, 8);
    rv.unobserve(el);
    el.style.setProperty('--i', i); el.classList.add('rv-in');
    setTimeout(() => { el.removeAttribute('data-rv'); el.classList.remove('rv-in'); el.style.removeProperty('--i'); }, i * STEP + 900);
    [el, ...el.querySelectorAll('[data-count]')].forEach((c) => counters.has(c) && wait(i * STEP + 150).then(counters.get(c)));
  });
}, { rootMargin: '0px 0px -40px 0px' });   // a little way in, but near enough the bottom for the footer's last line
if (!still) {
  root.querySelectorAll('.s-sec').forEach((sec) => new Set([...sec.querySelectorAll(HEAD), ...sec.querySelectorAll(PANEL), ...sec.querySelectorAll(BODY)]).forEach((el) => {
    el.dataset.rv = el.matches(PANEL) ? 'panel' : ''; rv.observe(el);
  }));
  counters.forEach((_, el) => el.closest('[data-rv]') || rv.observe(el));   // a figure outside any block counts on its own
  root.classList.add('rv');
}

// the opening sentence waits at low opacity and lights up word by word with the scroll, as its top climbs from FROM to TO of the screen.
// The words stay inline, so it breaks as before; a soft front SOFT words wide. Read once more as it leaves the screen, so a jump lands on the right end
const lede = root.querySelector('.s-lede > p:not(.dim)');
if (lede && !still) {
  const FROM = 0.86, TO = 0.46, DIM = 0.26, SOFT = 5;
  const words = lede.textContent.trim().split(/\s+/).map((word) => Object.assign(document.createElement('span'), { textContent: word }));
  lede.replaceChildren(...words.flatMap((w, i) => (i ? [' ', w] : [w])));
  const paint = () => {
    const top = lede.getBoundingClientRect().top / innerHeight, k = Math.min(1, Math.max(0, (FROM - top) / (FROM - TO)));
    words.forEach((w, i) => { w.style.opacity = (DIM + (1 - DIM) * Math.min(1, Math.max(0, (k * (words.length + SOFT - 1) - i) / SOFT))).toFixed(3); });
  };
  let near = false, queued = false;
  new IntersectionObserver(([e]) => { near = e.isIntersecting; paint(); }).observe(lede);
  addEventListener('scroll', () => { if (near && !queued) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); } }, { passive: true });
  paint();
}

// the price list: text, image, video and voice, each a tab over its models going by in lanes (sections.css). models.json holds
// AntSeedStats' most used models, one per family and dealt maker by maker, with their prices and the day they were read
// (node apps/website/scripts/site-models-refresh.mjs reads them again). Each card: its maker's mark (in its colours from labs-color/, else in the
// text colour), a text model's saving on the lab's price, the
// name, the price and how many providers serve it. Two lanes, one for a short list; each holds its cards twice, repeated
// within a copy until it is wider than any screen, so it loops.
// The lanes have two moving modes, the switch under them ("Ants") between the two: the mascot carrying each model (the default), or
// the cards walking on their own (Ant mode); the plain sliding lanes stay for reduced motion. The little ant's sprite and its table
// (assets/home/carry, built by its build.py) come with models.json
// Unique ants: every carrier is one of VARIANTS, its own size and its own sheet (a sprite and its table, carry/<sheet>.webp
// and .json, as build.py writes them). Every one carries its card as the worker does, the same poses, its hand on the card's lower
// corner. CARRY says, for each way, where
// the card sits from the point of the painted card where the sheet holds it (the sheet's corner, on the card's bottom at its hold):
// dx, dy (sheet px, the real card that far right and down of the painted one) and which layer is in front: 'hand' (the ant behind, what
// of it lies over the painted card over it) or 'ant' (the whole ant in front); push's ahead: the share that walk in front of their card
// instead. CARRY_ART off: every variant pushes its card on the worker's sheet, at its own size and its own stride (a fallback, should a
// sheet go missing)
const CARRY_ART = true;
const CARRY = {
  push: { dx: 0, dy: 0, front: 'hand', ahead: 0.5 },   // pushing from behind, a hand on the card's lower corner
};
const VARIANTS = [
  { id: 'worker', sheet: 'ant', scale: 1, carry: 'push' },
  { id: 'young', sheet: 'young', scale: 0.9, carry: 'push' },             // small, a red beanie
  { id: 'glasses', sheet: 'glasses', scale: 1.06, carry: 'push' },        // round glasses, a grey hoodie
  { id: 'bandana', sheet: 'bandana', scale: 0.97, carry: 'push' },        // golden, a light blue bandana
  { id: 'headphones', sheet: 'headphones', scale: 1.02, carry: 'push' },  // golden orange, lime headphones
];
const SHEET = (name, ext) => new URL(`/site/assets/home/carry/${name}.${ext}`, import.meta.url).href;
const flow = root.querySelector('.s-flow'), media = root.querySelector('.s-media');
const [models, sheets] = flow ? await Promise.all([
  fetch(new URL('models.json', import.meta.url)).then((r) => r.json()).catch((err) => console.warn('models not loaded', err)),
  still ? null : Promise.all([...new Set([VARIANTS[0].sheet, ...(CARRY_ART ? VARIANTS.map((v) => v.sheet) : [])])].map((name) =>
    fetch(SHEET(name, 'json')).then((r) => r.json()).catch((err) => console.warn('carrying ant not loaded', name, err)).then((t) => [name, t]))).then(Object.fromEntries),
]) : [];
const sprite = sheets?.[VARIANTS[0].sheet];   // the worker's: without it the cards walk on their own
if (models) {
  const ICONS = '/site/assets/home/icons/', UNIT = { text: '/M', image: '/image', video: '/s', voice: '/M chars' }, PACE = 32;   // px a second
  const usd = (v) => `$${v >= 0.1 ? v.toFixed(2) : +v.toPrecision(2)}`;
  const tabs = [...media.querySelectorAll('[role="tab"]')];
  const many = (n) => `provider${n === 1 ? '' : 's'}`;
  const top = (m) => `<div class="top"><i class="mark${m.logo.startsWith('labs-color/') ? ' color' : ''}" style="--i:url(${ICONS}${m.logo})"></i>${m.save != null ? `<em>−${m.save}%</em>` : ''}</div>`;
  const card = (m, medium) => `<li class="s-mcard">${top(m)}<b>${m.name}</b><p><code>${usd(m.price)}<span>${UNIT[medium]}</span></code>`
    + `<span class="prov" title="${m.providers} ${many(m.providers)}"><i aria-hidden="true"></i>${m.providers}<span class="sr"> ${many(m.providers)}</span></span></p></li>`;
  // a carried model: the card as it is, with the little ant behind it (.ant) and its arm and hand over its lower corner (.ant.hand)
  const carried = (m, medium) => card(m, medium).replace('<li class="s-mcard">', '<li class="s-mcard carry"><i class="ant" aria-hidden="true"></i><i class="ant hand" aria-hidden="true"></i><i class="shade" aria-hidden="true"></i>');
  const SPEED = [1, 0.81, 1.12];   // the launch: the second lane at 47 px/s to the first's 58, the other way
  const fill = (tab) => {
    const medium = tab.dataset.medium, rows = models.media[medium] || [], LANES = rows.length >= 4 ? 2 : 1, carry = ant.on && ant.carry;
    const side = parseFloat(getComputedStyle(flow).getPropertyValue('--card')) || 176, size = carry ? ant.reach(side) : side;
    const CARD = size + (carry ? CARRY_GAP : ant.on ? ANT_GAP : 12);
    const wide = Math.max(2400, flow.clientWidth + 3 * CARD);
    flow.classList.toggle('ants', ant.on && !carry);
    flow.classList.toggle('carry', carry);
    flow.innerHTML = Array.from({ length: LANES }, (_, k) => {
      const mine = rows.filter((_, i) => i % LANES === k);
      if (!mine.length) return '';
      const once = mine.map((m) => (carry ? carried : card)(m, medium)).join(''), times = Math.ceil(wide / (mine.length * CARD));
      const extra = once.repeat(times - 1).replace(/<li /g, '<li aria-hidden="true" ');
      if (carry) return `<div class="s-lane ant carry${k ? ' back' : ''}" style="${ant.geometry(side, k)}"><ul>${once}${extra}</ul></div>`;
      if (ant.on) return `<div class="s-lane ant"><ul>${once}${extra}</ul></div>`;
      return `<div class="s-lane${k === 1 ? ' back' : ''}" style="--dur:${(mine.length * times * CARD / PACE / SPEED[k]).toFixed(1)}s">`
        + `<ul>${once}${extra}</ul><ul aria-hidden="true">${once.repeat(times)}</ul></div>`;
    }).join('');
    if (ant.on) ant.start(side);
  };

  // Ant mode: the cards walk like a trail of ants. Each lane is a loop; every card has
  // its own place and pace on it, wavering a little, and now and then stops for a moment (carriers never: they keep the client's steady 58 and
  // 47 px/s, close any gap that opens at up to twice that, and ride a flat line); the one behind keeps its distance, so a stop
  // closes the line up and the restart ripples back down it, each setting off softly. They ride a gently winding path, tilted with it.
  // The card under the pointer stops: those ahead walk on, those behind queue up behind it, KEEP apart, like cars in a jam. A click on
  // it and it jumps (a bounce, a shiver), then rushes on to catch up with the tail of those ahead and settles back to its pace; the
  // queue behind sets off one after another, each once the one ahead has opened GO px. Still off screen, never with reduced motion.
  // Carry mode runs the same walk with each card hauled by a little ant (a third of the card's height) at its trailing side, its
  // hand on the card's lower corner (the first walk cycle's art); some walk behind their card, the near hand over it,
  // some in front of it, as it falls (the same on every load): the first lane walks right as drawn, the second left (the ant mirrored,
  // never the card). Its walk steps on with the ground it covers (the sprite's even steps), so the feet hold, and the card rises and
  // falls a little with each step, carried; the path's bob stays, the tilt goes. Under the pointer it stops and looks at you, lifting
  // the card a touch, those behind queueing up (carryOn); standing still it stands on both feet, lost; a click and it hops
  // (LIFT px more, a little bounce as it lands), then sprints to catch up with the ones ahead, its queue after it.
  const ANT_GAP = 44, KEEP = 10, GO = 18, WAVE = 6, BEND = 600, POP = 0.42, RUSH = 3.4;
  const CARRY_GAP = 36, CARRY_PACE = 58 / 32,   /* the client's pace, 58 px/s */ HOP = 0.56, LIFT = 10, SETTLE = 0.75, STILL = 8;   // a carrier hurries: half again as fast as the lanes did, its short, even steps at ~26 a second
  // a fixed coin per carrier, from its lane and place, so the ants in front and behind fall the same way on every load
  const coin = (k, i) => { let t = Math.imul((k + 1) * 7919 + i * 104729, 2654435761) >>> 0; t ^= t >>> 15; t = Math.imul(t, 2246822507) >>> 0; t ^= t >>> 13; return t / 4294967296; };
  // coin comes out signed, from -0.5 to 0.5 (so every carrier walks in front of its card, as on production); draw, 0 to 1
  const draw = (k, i) => ((coin(k, i) * 4294967296) >>> 0) / 4294967296;
  const ant = { on: false, carry: false, lanes: [], raf: 0, last: 0, vt: 0, seen: false,
    // a variant as it walks today: its own sheet and way of carrying once CARRY_ART is on and it has a sheet of its own that has come,
    // else the worker's sheet, pushing (never a carry faked on art that does not hold the card so); its own size either way
    use(v) { const own = CARRY_ART && v.sheet !== VARIANTS[0].sheet && sheets[v.sheet]; return { t: own || sprite, name: own ? v.sheet : VARIANTS[0].sheet, c: CARRY[own ? v.carry : 'push'] }; },
    // a variant on a card of this side (CSS px) in lane k, from its sheet's table: its cell as CSS variables (sections.css), the cell
    // (--aw, --ah) set with its corner on the card's bottom where the sheet holds it (hold: 0 its left corner, 0.5 its middle; mirrored
    // in the second lane), moved by its carry's dx, dy; the sheet (--sheet, --sw, --sh); how far its feet go below the card (below), how
    // far it reaches past the card behind and ahead. And its frames (look): each one's background-position for the ant and its hand (the
    // walk's, the run's, then stand, look, hop), how far the card rises on each so the feet stay on the ground, where in its cycle each
    // walk and run frame starts, in px gone. Its size scales all of it, the stride too, so a big ant takes longer steps at the lane's
    // pace and its feet still hold
    fit(v, side, k) {
      const { t, name, c } = this.use(v), g = side / t.card * v.scale, [cw, ch] = t.cell, [x, y] = t.corner, dx = c.dx * g, dy = c.dy * g;
      const px = (n) => `${n.toFixed(2)}px`, fx = t.hold || 0, h0 = fx * side, hx = k ? side - h0 : h0;
      const ax = k ? hx - (cw - x) * g + dx : hx - x * g - dx, ax0 = h0 - x * g - dx;
      const at = (n, row) => `${px(-n * cw * g)} ${px(-row * ch * g)}`;
      const cycle = (steps) => { let gone = 0; const from = steps.map((s) => { const a = gone; gone += s * g; return a; }); return { from, length: gone }; };
      return { below: (t.ground - y) * g - dy, behind: Math.max(0, -ax0), beyond: Math.max(0, ax0 + cw * g - side), front: c.front, ahead: c.ahead || 0,
        vars: `--sheet:url(${SHEET(name, 'webp')});--aw:${px(cw * g)};--ah:${px(ch * g)};--ax:${px(ax)};--ay:${px(side - y * g - dy)};--sw:${px(cw * g * t.lift.length)};--sh:${px(ch * g * 2)}`,
        look: { back: t.lift.map((_, n) => at(n, 0)), hand: t.lift.map((_, n) => at(n, 1)), lift: t.lift.map((l) => l * g),
          walk: cycle(t.steps), run: cycle(t.runSteps), W: t.walk, stand: t.stand, look: t.look, hop: t.hop } };
    },
    fits(side, k) { return VARIANTS.map((v) => this.fit(v, side, k)); },
    // how far a carrier reaches: its card and the biggest ant's reach past it, so every carrier keeps the same place in the line
    reach(side) { const f = this.fits(side, 0); return side + Math.max(...f.map((a) => a.behind)) + Math.max(...f.map((a) => a.beyond)); },
    // a carry lane's own variables: the worker's cell (until each card has its own) and the room under the cards, for the lowest feet
    geometry(side, k) { const f = this.fits(side, k); return `${f[0].vars};--below:${Math.max(...f.map((a) => a.below)).toFixed(2)}px`; },
    // which variant carries each card of lane k (n cards, a loop), the same on every load: drawn from the coin among those that differ
    // from both neighbours (the last card's neighbour is the first), and if it can, from the one two places back and from the card of
    // the lane above at the same place, so the two lanes start offset
    cast(k, n, above) {
      const all = VARIANTS.map((_, j) => j), out = [];
      for (let i = 0; i < n; i++) {
        const near = [out[i - 1], i === n - 1 ? out[0] : undefined].filter((j) => j !== undefined);
        const far = [out[i - 2], i >= n - 2 ? out[(i + 2) % n] : undefined, above?.[i]].filter((j) => j !== undefined);
        const hard = (j) => !near.includes(j);
        let can = all.filter((j) => hard(j) && !far.includes(j));
        if (!can.length) can = all.filter(hard);
        out.push(can[Math.floor(draw(k + 4, i) * can.length)]);
      }
      return out;
    },
    start(side) {
      const carry = this.carry;
      let above = null;
      this.lanes = [...flow.querySelectorAll('.s-lane.ant')].map((lane, k) => {
        const els = [...lane.querySelectorAll('.s-mcard')];
        const size = carry ? this.reach(side) : els[0]?.offsetWidth || 176, step = size + (carry ? CARRY_GAP : ANT_GAP);
        const fits = carry && this.fits(side, k), dir = carry ? (k ? -1 : 1) : (k === 1 ? 1 : -1);
        const who = carry ? (above = this.cast(k, els.length, above)) : [];
        const ln = { lane, size, t: 0, vl: 0, vr: 0, L: els.length * step, dir, V: PACE * (carry ? CARRY_PACE : 1.3) * SPEED[k], k, held: null, carry, pop: carry ? HOP : POP,
          // the ant past the card's trailing side (left, walking right) or leading side (left, walking left): the card starts that far in
          off: carry ? Math.max(...fits.map((f) => (dir > 0 ? f.behind : f.beyond))) : 0,
          c: els.map((el, i) => {
            const f = carry && fits[who[i]], a = { el, back: el.children[0], hand: el.children[1], shade: el.children[2], x: i * step, v: carry ? PACE * CARRY_PACE * SPEED[k] : PACE * SPEED[k], rest: 0, ph: Math.random() * 6.28,
              queued: false, pop: 0, rush: 0, wp: 0, rp: 0, fr: -1, gait: -1, ly: 0, dl: 0 };
            if (!f) return a;
            // its own cell, its frames and its stride's phase (from the coin); every card on the same line, whatever carries it
            el.dataset.ant = VARIANTS[who[i]].id;
            el.style.cssText = `${f.vars};--below:${f.below.toFixed(2)}px`;
            el.classList.toggle('ahead', f.front === 'ant' || (f.front === 'hand' && coin(k, i) < f.ahead));
            return Object.assign(a, { L: f.look, wp: draw(k + 8, i) * f.look.walk.length, });
          }) };
        const of = (e) => ln.c.find((a) => a.el === e.target.closest?.('.s-mcard'));
        // a real move of the pointer, not a card sliding under a still one, so a queue can leave from under it after a click
        lane.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && (e.movementX || e.movementY)) ln.held = of(e) || null; });
        lane.addEventListener('pointerleave', () => { ln.held = null; });
        lane.addEventListener('click', (e) => {
          const a = of(e);
          if (!a) return;
          if (ln.held === a) ln.held = null;
          a.pop = ln.pop; a.rush = ln.carry ? 0 : 6; a.rest = 0; a.queued = false; a.rp = 0;
        });
        return ln;
      });
      this.view(); this.draw(0); this.wake();
    },
    // the part of each lane on screen, in its own px (the cards' x), so a carrier's spacing can come back where nobody sees it
    view() { for (const ln of this.lanes) { const l = ln.lane.getBoundingClientRect().left; ln.vl = -l; ln.vr = innerWidth - l; } },
    // whether a carrier at x is out of sight, the whole of it and its ant, with a margin
    hid(ln, x) { const X = x - ln.size + ln.off; return X - ln.size > ln.vr + 8 || X + ln.size < ln.vl - 8; },
    wake() { if (!this.raf && this.on && this.seen && !still && !document.hidden) { this.last = performance.now(); this.raf = requestAnimationFrame((t) => this.frame(t)); } },
    frame(now) {
      this.raf = 0;
      if (!this.on || !this.seen || document.hidden) return;
      const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
      if (now - this.vt > 1000) { this.vt = now; this.view(); }   // the lanes' place on screen, checked now and then (a swipe, a scroll sideways)
      for (const ln of this.lanes) {
        const n = ln.c.length;
        if (ln.carry) { this.carryOn(ln, dt); continue; }
        for (let i = 0; i < n; i++) {
          const a = ln.c[i], ahead = ln.c[(i + (ln.dir < 0 ? n - 1 : 1)) % n];
          const gap = ((ln.dir < 0 ? a.x - ahead.x : ahead.x - a.x) % ln.L + ln.L) % ln.L - ln.size;
          const pace = ln.carry ? ln.V : ln.V * (0.8 + 0.25 * Math.sin(now / 900 + a.ph));   // a carrier keeps the client's steady pace
          if (a.rest > 0) a.rest -= dt; else if (!ln.carry && !a.rush && Math.random() < dt * 0.09) a.rest = 0.3 + Math.random() * 0.8;
          if (a.queued && gap > KEEP + GO) a.queued = false;   // the one ahead has pulled away: off it goes
          if (a.pop > 0) a.pop -= dt;
          else if (a.rush > 0) { a.rush -= dt; if (gap < ANT_GAP + 4) a.rush = 0; }   // caught up with the tail ahead (or gave up)
          let want = pace, rate = ln.carry ? 2.2 : 1.8;                                   // sets off softly
          if (a === ln.held || a.pop > 0) { want = 0; rate = 12; }                         // stops short under the pointer
          else if (a.rush > 0) { want = ln.carry ? Math.min(2 * ln.V, pace + (gap - ANT_GAP) * 1.6) : pace + Math.min(ln.V * RUSH, (gap - ANT_GAP) * 1.6); rate = 5; }   // hurries, easing in as it nears: a carrier at twice the lane's pace
          else if (a.rest > 0 || a.queued) { want = 0; rate = 7; }
          else if (ln.carry && gap > CARRY_GAP + 6) { want = Math.min(2 * ln.V, ln.V + (gap - CARRY_GAP) * 1.4); rate = 4; }   // a gap opened ahead: it closes it, as on the client's
          a.v += (want - a.v) * Math.min(1, dt * rate);
          const room = (gap - KEEP) / dt;
          if (a.v > room) { a.v = Math.max(0, room); if (a.v < 1 && want > 0 && !a.rush) a.queued = true; }   // never closer than KEEP: it waits in line
          a.x = ((a.x + ln.dir * a.v * dt) % ln.L + ln.L) % ln.L;
          // the walk cycle, as far as it went; hurrying, a carrier takes quick little steps, its walk at one and a half times the ground
          // it covers
          if (ln.carry) { a.wp = (a.wp + a.v * dt * (a.rush > 0 && a.pop <= 0 ? 1.5 : 1)) % a.L.walk.length; if (a.rush > 0) a.rp += a.v * dt; }
        }
      }
      this.draw(now);
      // the next frame keeps this one's clock (wake would restart it and lose ~1 ms a frame, ~6% of the pace)
      if (!still && !document.hidden) this.raf = requestAnimationFrame((t) => this.frame(t));
    },
    // the carriers. Each follows the one ahead like a car: at the lane's pace and spacing it walks the lane's pace; it
    // aims for a gap that grows with the speed ahead, from KEEP (standing) to CARRY_GAP (walking), and never goes faster than its cap,
    // the lane's pace, or more while it has a boost (b). The one under the pointer stops (or hops, on a click): those behind ease up and
    // queue KEEP apart; those ahead walk on, and once out of sight past the edge each waits for the one behind it, so the gap ahead is
    // never wider than the screen, however long the hold. Let go (or after the hop), it sprints at up to twice the pace to close that
    // gap, and those queued behind it set off after it, one after another, each with a smaller boost than the one in front, so the queue
    // stretches back to its spacing; the ones waiting out of sight walk on as it closes. A boost ends once its ant is back in step
    carryOn(ln, dt) {
      ln.t += dt;
      const n = ln.c.length, V = ln.V, back = ln.dir < 0 ? 1 : n - 1, fwd = ln.dir < 0 ? n - 1 : 1;
      const gap = (a, b) => ((ln.dir < 0 ? a.x - b.x : b.x - a.x) % ln.L + ln.L) % ln.L - ln.size;
      for (let i = 0; i < n; i++) {
        const a = ln.c[i], stop = a === ln.held || a.pop > 0;
        if (a.was && !stop) {   // let go, or landed: it sprints, and its queue after it, each boost smaller
          a.b = 1; a.kt = ln.t;
          for (let m = 1, f = ln.c[(i + back) % n], k = i; m < n; m++, k = (k + back) % n, f = ln.c[(k + back) % n]) {
            if (gap(f, ln.c[k]) > KEEP + 14) break;
            f.b = Math.max(f.b || 0, Math.max(0.2, 1 - 0.15 * m)); f.kt = ln.t;
          }
        }
        a.was = stop;
      }
      for (let i = 0; i < n; i++) {
        const a = ln.c[i], ahead = ln.c[(i + fwd) % n], after = ln.c[(i + back) % n], stop = a === ln.held || a.pop > 0, g = gap(a, ahead);
        if (a.pop > 0) a.pop -= dt;
        let want = 0;
        if (!stop) {
          const aim = KEEP + (CARRY_GAP - KEEP) * Math.min(1, ahead.v / V);
          want = Math.max(0, Math.min(V * (1 + (a.b || 0)), ahead.v + (g - aim) * 2));
          if (this.hid(ln, a.x)) want = Math.min(want, V * Math.max(0, Math.min(1, 1 - (gap(after, a) - CARRY_GAP) / 60)));   // out of sight: waits for the one behind
        }
        a.v += (want - a.v) * Math.min(1, dt * (stop ? 12 : want < a.v ? 8 : 5));
        a.v = Math.max(0, Math.min(a.v, (g - 4) / dt));   // never into the one ahead
        if (a.b && ln.t - a.kt > 0.8 && ((g < CARRY_GAP + 4 && a.v > 0.97 * V) || ln.t - a.kt > 40)) a.b = 0;   // back in step
        a.x = ((a.x + ln.dir * a.v * dt) % ln.L + ln.L) % ln.L;
        a.wp = (a.wp + a.v * dt * (a.v > 1.1 * V ? 1.5 : 1)) % a.L.walk.length;   // hurrying, short quick steps
      }
    },
    draw(now) {
      for (const ln of this.lanes) for (const a of ln.c) {
        const X = a.x - ln.size, th = (X / BEND) * 6.283 + ln.k * 1.9 + now / 4000;
        const y = ln.carry ? 0 : WAVE * Math.sin(th);   // carriers on a flat line: only the step's own lift
        if (ln.carry) { this.pose(ln, a, X, y); continue; }
        const hurry = a.rush > 0 && a.pop <= 0 ? Math.min(1, Math.max(0, (a.v - ln.V) / ln.V)) : 0;
        const tilt = Math.atan(WAVE * 6.283 / BEND * Math.cos(th)) * 57.3 * 0.5 + hurry * 2.2 * Math.sin(now / 38 + a.ph);   // a stressed ant wobbles
        // the jump on a click: a damped bounce in size and a shiver, fading out over POP
        const k = a.pop > 0 ? a.pop / POP : 0, s = 1 + 0.13 * k * Math.sin((1 - k) * 7.85), jx = 2.4 * k * Math.sin(now / 21), jy = 1.2 * k * Math.cos(now / 27);
        a.el.style.transform = `translate(${(X + jx).toFixed(1)}px, ${(y + jy).toFixed(1)}px) rotate(${tilt.toFixed(2)}deg)${k ? ` scale(${s.toFixed(3)})` : ''}`;
      }
    },
    // a carrying ant's frame (the walk's, the run's; stand when still, look under the pointer, hop) and how high its card rides: the
    // frame's own lift, which keeps the feet on the ground (the run's leaves it at the top of its stride), the card carried over a
    // change of gait or pose and settling, so looking at you lifts it rather than jumps it, and the hop's bounce. Never a frozen
    // stride: below a crawl it stands. The sprite changes only when the frame does; the card and its ant only move (transforms)
    pose(ln, a, X, y) {
      const L = a.L, at = (c, d) => { let n = c.from.length - 1; while (n && c.from[n] > d) n--; return n; };
      let fr, bounce = 0;
      if (a.pop > 0) {
        const t = 1 - a.pop / ln.pop;   // up and down in the hop, then a little bounce as it lands, standing
        if (t < 0.72) { fr = L.hop; bounce = LIFT * Math.sin(Math.PI * t / 0.72); }
        else { fr = L.stand; bounce = 3 * Math.sin(Math.PI * (t - 0.72) / 0.28); }
      } else if (a === ln.held) fr = L.look;
      else if (a.v < STILL) fr = L.stand;   // still, or all but: on both feet
      else fr = at(L.walk, a.wp);
      if (fr !== a.fr) { a.fr = fr; a.back.style.backgroundPosition = L.back[fr]; a.hand.style.backgroundPosition = L.hand[fr]; }
      const gait = fr < L.W ? 0 : fr < L.stand ? 1 : fr;
      if (gait !== a.gait) { if (a.gait >= 0) a.dl = a.ly - L.lift[fr]; a.gait = gait; }
      a.dl *= SETTLE;
      a.ly = L.lift[fr] + a.dl;
      a.el.style.transform = `translate(${(X + ln.off).toFixed(1)}px, ${(y - a.ly - bounce).toFixed(1)}px)`;
      // its shadow stays on the ground as the card bobs and hops (the card's rise undone), a little smaller and fainter in the air
      if (a.shade) { const up = bounce / LIFT; a.shade.style.transform = `translateY(${(a.ly + bounce).toFixed(1)}px) scale(${(1 - 0.2 * up).toFixed(3)})`; a.shade.style.opacity = (1 - 0.35 * up).toFixed(2); }
    },
  };
  const tabNow = () => tabs.find((b) => b.getAttribute('aria-selected') === 'true') || tabs[0];
  // the ants always carry the models once the sprite's table has come; without it, or with reduced
  // motion, the cards walk on their own
  ant.on = !still;
  if (sprite) ant.carry = true;
  document.addEventListener('visibilitychange', () => ant.wake());
  // the lanes are built for a size of card and ant: built again when the phone's size comes or goes
  addEventListener('resize', () => ant.view());
  if (ant.on) matchMedia('(max-width: 760px)').addEventListener('change', () => fill(tabNow()));
  // the chosen tab's place, for the thumb that slides under it (sections.css)
  const mark = () => {
    const t = tabNow();
    media.style.setProperty('--tx', `${t.offsetLeft}px`); media.style.setProperty('--tw', `${t.offsetWidth}px`);
  };
  // the tabs: a click, or the arrow keys, Home and End, as the install block's in index.html. The chosen medium's lanes fade in
  // the lanes change with a swipe the way the tab went: the old ones slip out to the side, blurred and fading, the new
  // ones come in from the other side and sharpen. A quick second click cuts the first swipe short
  let swipe = 0;
  const show = (tab, focus) => {
    if (focus) tab.focus();
    if (tab.getAttribute('aria-selected') === 'true') return;
    const dir = Math.sign(tabs.indexOf(tab) - tabs.indexOf(tabNow())) || 1;
    for (const t of tabs) { const on = t === tab; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; }
    flow.setAttribute('aria-labelledby', tab.id); mark();
    if (still) { fill(tab); return; }
    const me = ++swipe, D = 72;
    flow.getAnimations().forEach((x) => x.cancel());
    flow.animate([{ transform: 'none', filter: 'blur(0)', opacity: 1 }, { transform: `translateX(${-dir * D}px)`, filter: 'blur(6px)', opacity: 0 }],
      { duration: 170, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' }).finished.then(() => {
      if (me !== swipe) return;
      fill(tab);
      flow.getAnimations().forEach((x) => x.cancel());
      flow.animate([{ transform: `translateX(${dir * D}px)`, filter: 'blur(6px)', opacity: 0 }, { transform: 'none', filter: 'blur(0)', opacity: 1 }],
        { duration: 320, easing: 'cubic-bezier(0, 0, .2, 1)' });
    }, () => {});
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => show(t));
    t.addEventListener('keydown', (e) => {
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault(); show(tabs[(to + tabs.length) % tabs.length], true);
    });
  });
  fill(tabs[0]); mark();
  new ResizeObserver(mark).observe(media);
  document.fonts.ready.then(() => { mark(); media.offsetWidth; media.classList.add('ready'); });   // placed first, then it may slide
  new IntersectionObserver(([e]) => { flow.classList.toggle('on', e.isIntersecting && !still); ant.seen = e.isIntersecting; ant.wake(); }).observe(flow);
}

// $ANTS: its live figures came off the page their script is kept in 

// the terminal types each command a key at a time behind a caret, and prints each answer whole. Every line holds its place from the
// start (hidden, not missing), and the part of a command not yet typed stays in its line, hidden, so the box never changes size
const term = root.querySelector('.term');
if (term && !still) {
  term.classList.add('typing');
  const caret = Object.assign(document.createElement('span'), { className: 'cur' }), rest = Object.assign(document.createElement('span'), { className: 'rest' });
  const keys = (ln) => (ln.matches('.c') ? ln.firstChild : ln.querySelector('b') && ln.querySelector('.c')?.firstChild);   // a command's text, or nothing
  onView([term.closest('.wash') || term], async () => {
    const lines = [...term.querySelectorAll('.ln')];
    for (const [k, ln] of lines.entries()) {
      const text = keys(ln), next = lines[k + 1];
      if (k && ln.parentElement !== lines[k - 1].parentElement) await wait(500);   // over to the second pane
      if (!text) { ln.classList.add('shown'); await wait(110); continue; }
      const full = text.data;
      let n = full.length - full.trimStart().length;   // a continued line's indent comes at once
      text.data = full.slice(0, n); rest.textContent = full.slice(n); text.after(caret, rest); ln.classList.add('shown');
      if (!ln.matches('.c')) await wait(420);   // the prompt, the caret blinking, then the keys
      caret.classList.add('busy');
      while (n < full.length) { n++; text.data = full.slice(0, n); rest.textContent = full.slice(n); await wait(24 + Math.random() * 14); }
      caret.classList.remove('busy');
      await wait(next?.matches('.c') ? 140 : next?.matches('.j') ? 700 : 320);   // the next line of the command, or Enter (and the reply)
      caret.remove(); rest.remove(); text.data = full;
    }
  }, 0.35);
}

// the Gateway's router picture (square and told one route at a time in out of the gateway's bottom in
// sections.html .gw). Its links are drawn here from where the pieces sit, so each lands on an edge at every width: one down from each
// caller into your gateway, and one out of the gateway's bottom edge, straight down the same column to its provider, a lime dot where
// it leaves, the rule's word on a tag over the provider. Then the three routes play in turn, looping while on screen: the caller lights
// and its line draws into the gateway, its rule's row lights (with its dot, --hi), the line draws out to its provider with the request
// riding it; hold. Claude Code by price to the cheapest, the support bot by speed to the fastest, the research agent by privacy to the TEE; then a
// short rest with the whole picture at ease. What is not in the route is dimmed, never hidden: its lines to DIM, and on the glass
// pieces only what is on them, to INK (--o), the glass kept whole so they stay legible on the painting. With reduced motion, and
// until it is first on screen, the first route stands complete; paused off screen. Measured through offsets, not boxes, so the panels'
// rise and unveil (scaled) never skew them; redrawn when the picture changes size
const gw = root.querySelector('.gw');
if (gw) {
  const NS = 'http://www.w3.org/2000/svg', svg = gw.querySelector('.gw-links'), hub = gw.querySelector('[data-gw="hub"]');
  const plate = gw.querySelector('.gw-plate'), rows = [...hub.querySelectorAll('.gw-rules > div')], ins = [...gw.querySelectorAll('[data-gw="in"]')];
  const outs = [...gw.querySelectorAll('[data-gw="out"]')].sort((a, b) => a.dataset.row - b.dataset.row);   // route k: caller k, row k, its provider
  const tags = outs.map((o) => {
    const t = gw.appendChild(Object.assign(document.createElement('span'), { className: 'gw-rule' }));
    t.append(Object.assign(document.createElement('span'), { textContent: o.dataset.rule }));
    return t;
  });
  const box = (el) => {
    let x = 0, y = 0;
    for (let e = el; e && e !== gw; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
    return { l: x, t: y, r: x + el.offsetWidth, b: y + el.offsetHeight, cx: x + el.offsetWidth / 2, cy: y + el.offsetHeight / 2 };
  };
  const f = (v) => +v.toFixed(1);
  const el = (tag, cls, d) => { const e = document.createElementNS(NS, tag); if (cls) e.setAttribute('class', cls); if (d) e.setAttribute('d', d); return e; };
  const bubble = () => {   // net.js's request: a rounded box with a tail and three dots, 24 by 16, centred on its place
    const g = el('g', 'bub'), w = 24, h = 16, r = 6, x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2;
    g.innerHTML = `<path d="M${x0 + r},${y0} H${x1 - r} Q${x1},${y0} ${x1},${y0 + r} V${y1 - r} Q${x1},${y1} ${x1 - r},${y1} H${-w * .1} L${-w * .4},${y1 + h * .36} L${-w * .3},${y1} H${x0 + r} Q${x0},${y1} ${x0},${y1 - r} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} Z"/>`
      + [-1, 0, 1].map((k) => `<circle cx="${f(k * w * .22)}" cy="0" r="1.6"/>`).join('');
    return g;
  };
  let routes = [], bub;
  // the lines pass under the glass: the svg sits in the plate, under its windows, laid over the whole picture from the
  // plate's corner (.gw-lay) so it still draws in the picture's px; each line starts and ends UNDER inside its windows
  const lay = svg.parentNode, UNDER = 8;
  const draw = () => {
    const h = box(hub), p = box(plate), o = box(lay), W = gw.offsetWidth, H = gw.offsetHeight;
    Object.assign(svg.style, { left: `${-o.l}px`, top: `${-o.t}px`, width: `${W}px`, height: `${H}px` });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const dim = el('g', 'dim'), hi = [];
    routes = outs.map((o, k) => {
      const c = box(ins[k]), b = box(o), t = tags[k], tt = b.t - 8 - t.offsetHeight;
      t.style.translate = `${f(b.cx - t.offsetWidth / 2)}px ${f(tt)}px`;
      const din = `M${f(c.cx)},${f(c.b - UNDER)} V${f(h.t + UNDER)}`, dout = `M${f(b.cx)},${f(h.b - UNDER)} V${f(b.t + UNDER)}`;
      dim.append(el('path', 'u', din), el('path', 'u', dout), el('path', '', din), el('path', '', dout));
      const g = el('g'), lines = [el('path', 'u', din), el('path', 'u', dout), el('path', '', din), el('path', '', dout)];
      lines.forEach((l) => { l.setAttribute('pathLength', 1); l.style.strokeDasharray = '1 1'; });
      const tick = el('circle', 'tick');   // where the line leaves the gateway's bottom edge
      tick.setAttribute('cx', f(b.cx)); tick.setAttribute('cy', f(h.b)); tick.setAttribute('r', 2.5);
      g.append(...lines, tick); hi.push(g);
      // the request rests half-way down the gap between the plate and the tag: the length along the line where it reaches that height
      const out = lines[3], len = out.getTotalLength(), mid = (p.b + tt) / 2;
      let lo = 0, up = len;
      for (let i = 0; i < 24; i++) { const m = (lo + up) / 2; if (out.getPointAtLength(m).y < mid) lo = m; else up = m; }
      return { g, lines, tick, out, len, rest: lo };
    });
    bub = bubble();
    // under the glass the lines blur: drawn sharp outside the windows, and inside each window a heavily blurred twin
    // of the same lines (live <use> copies, so they animate with them), each half kept to its side by a mask of the windows' boxes
    const wins = [...ins, hub, ...outs].map(box), rect = (r, fill) => { const e = el('rect'); [['x', r.l], ['y', r.t], ['width', r.r - r.l], ['height', r.b - r.t]].forEach(([k, v]) => e.setAttribute(k, f(v))); e.setAttribute('fill', fill); return e; };
    const full = { l: -W, t: -H, r: 2 * W, b: 2 * H }, defs = el('defs'), mk = (id, base, win) => { const m = el('mask'); m.id = id; m.setAttribute('maskUnits', 'userSpaceOnUse'); m.append(rect(full, base), ...wins.map((r) => rect(r, win))); return m; };
    const blur = el('filter'); blur.id = 'gw-blur'; blur.setAttribute('x', '-50%'); blur.setAttribute('y', '-50%'); blur.setAttribute('width', '200%'); blur.setAttribute('height', '200%');
    // the twin is all lime (the lines' dark casing would blur to a grey smudge), blurred wide, its alpha raised so it shows through the glass
    const lime = getComputedStyle(svg).getPropertyValue('--gw-line').trim() || '#b9ee2a';
    const gb = el('feGaussianBlur'); gb.setAttribute('in', 'SourceAlpha'); gb.setAttribute('stdDeviation', '5'); gb.setAttribute('result', 'b');
    const fl = el('feFlood'); fl.setAttribute('flood-color', lime); const cp = el('feComposite'); cp.setAttribute('in2', 'b'); cp.setAttribute('operator', 'in');
    const ct = el('feComponentTransfer'), fa = el('feFuncA'); fa.setAttribute('type', 'linear'); fa.setAttribute('slope', '2.5'); ct.append(fa);
    blur.append(gb, fl, cp, ct);
    defs.append(mk('gw-out', '#fff', '#000'), mk('gw-in', '#000', '#fff'), blur);
    dim.id = 'gw-dim'; hi.forEach((g, k) => { g.id = `gw-hi${k}`; });
    const sharp = el('g'); sharp.setAttribute('mask', 'url(#gw-out)'); sharp.append(dim, ...hi);
    const soft = el('g'); soft.setAttribute('mask', 'url(#gw-in)');
    const softIn = el('g'); softIn.setAttribute('filter', 'url(#gw-blur)');
    softIn.append(...['gw-dim', ...hi.map((g) => g.id)].map((id) => { const u = el('use'); u.setAttribute('href', `#${id}`); return u; }));
    soft.append(softIn);
    svg.replaceChildren(defs, soft, sharp, bub);
    horizon();
    paint();
  };
  // the painting's horizon (assets/home/vignettes/gw-*.webp, square, its hills at HZ of its height) held just above the rule tags, a
  // quarter of the way up from them to the plate, so the plate's sky and the providers' land read as two places at every shape of
  // the panel: the painting covers the panel and is scaled up only as far as that needs. Measured as fractions of
  // the picture, which fills its panel, so the panels' rise and unveil (scaled) never skew it
  const wash = gw.closest('.wash'), HZ = .705;
  const horizon = () => {
    if (!wash) return;
    const g = gw.getBoundingClientRect(), y = (e, k) => (e.getBoundingClientRect()[k] - g.top) / g.height;
    const tag = y(tags[0], 'top'), fh = tag - (tag - y(plate, 'bottom')) / 4, W = wash.clientWidth, H = wash.clientHeight;
    if (!g.height || !H) return;
    const S = Math.max(W, H, fh * H / HZ, H * (1 - fh) / (1 - HZ));
    wash.style.backgroundSize = `${f(S)}px ${f(S)}px`;
    wash.style.backgroundPosition = `50% ${f(fh * H - HZ * S)}px`;
  };

  // the story, in seconds within a route (ROUTE long): the route before fades back to DIM, the caller lights, its line draws in, the
  // row lights, the line draws out with the request, the provider and its tag light as it lands; then held. After the three, REST:
  // every piece comes back up, the lines dimmed, before Claude Code starts again. The first time round, the phase before the first
  // route is the still frame itself (the first route complete), which fades as the story starts
  const ROUTE = 4.8, REST = 1.4, LOOP = 3 * ROUTE + REST, DIM = .35, INK = .5;
  const FADE = [0, .45], CALLER = [.1, .45], IN = [.55, .6], ROW = [1.15, .4], OUT = [1.55, 1.5], LAND = [2.85, .4], BACK = [.25, .6], GONE = [0, .3];
  const calm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);   // ease in and out
  const at = (u, [s, d]) => calm((u - s) / d);
  const to = (a, b, u, w) => a + (b - a) * at(u, w);
  let T = ROUTE - .01, first = true;   // the still frame: the first route complete, held
  const paint = () => {
    if (!routes.length) return;
    const n = routes.length, phase = Math.min(n, Math.floor(T / ROUTE)), u = T - phase * ROUTE, rest = phase === n;
    const before = phase ? phase - 1 : first ? -1 : n;   // the phase this one follows: a route, the rest (n), or the still frame (-1)
    const was = (j) => +(before === n || j === Math.max(0, before));   // how lit route j's pieces were when this phase began
    const lit = (j, w) => {   // how lit a piece of route j is, 0 to 1; w: when it lights in its own route (none: the caller, first)
      if (rest) return to(was(j), 1, u, BACK);
      if (j !== phase) return to(was(j), 0, u, FADE);
      if (!w) return to(was(j), 1, u, CALLER);
      return u < w[0] ? to(was(j), 0, u, FADE) : at(u, w);
    };
    const o = (v) => `${f(INK + (1 - INK) * v)}`, set = (e, k, v) => e.style.setProperty(k, v);
    const wasHi = (j) => +(j === before || (before === -1 && j === 0));   // was route j's row the chosen one when this phase began
    routes.forEach((r, j) => {
      set(ins[j], '--o', o(lit(j)));
      set(rows[j], '--o', o(lit(j, ROW)));
      set(rows[j], '--hi', f(j === phase && u >= ROW[0] ? at(u, ROW) : to(wasHi(j), 0, u, FADE)));
      set(outs[j], '--o', o(lit(j, LAND))); set(tags[j], '--o', o(lit(j, LAND)));
      // its lit line: drawn as its route plays, then fading back to the dimmed one under it as the next phase starts
      let op = 0, pin = 1, pout = 1;
      if (j === phase && !(before === -1 && u < IN[0])) { op = 1; pin = at(u, IN); pout = at(u, OUT); }
      else if (j === phase || phase === j + 1) op = 1 - at(u, FADE);
      r.g.style.opacity = f(op);
      r.lines.forEach((l, i) => { const v = i % 2 ? pout : pin; l.style.strokeDashoffset = f(1 - v); l.style.visibility = v > .001 ? '' : 'hidden'; });
      r.tick.style.visibility = pout > .001 ? '' : 'hidden';
    });
    if (rows[n]) set(rows[n], '--o', o(rest ? at(u, BACK) : before === n ? 1 - at(u, FADE) : 0));   // the fourth rule, in no route
    // the request: rides its route's line just behind the tip, from the gateway to its rest as the line lands, and stays there until
    // the next phase starts, when it fades
    let k = phase, s = 1, op;
    if (!rest && u >= OUT[0]) { s = at(u, OUT); op = Math.min(1, s * 6); }
    else { k = rest ? n - 1 : Math.max(0, phase - 1); op = before === n ? 0 : 1 - at(u, GONE); }
    const pt = routes[k].out.getPointAtLength(s * routes[k].rest);
    bub.setAttribute('transform', `translate(${f(pt.x)} ${f(pt.y)})`);
    bub.style.opacity = f(op);
  };
  new ResizeObserver(draw).observe(gw);
  document.fonts.ready.then(draw);
  if (!still) {
    // the clock runs while the picture is on screen, and only once its panel has arrived (card-unveil.js), so the story starts in sight
    const panel = gw.closest('.wash');
    let raf = 0, last = 0, seen = false;
    const frame = (now) => {
      const dt = Math.min(.1, (now - last) / 1000); last = now;
      if (!/wait|soon/.test(panel?.dataset.unveil || '')) {
        if (first && T === ROUTE - .01) T = 0;   // first in sight: the story begins
        else T += dt;
        if (T >= LOOP) { T -= LOOP; first = false; }
      }
      paint(); raf = requestAnimationFrame(frame);
    };
    const wake = () => {
      const go = seen && !document.hidden;
      if (go && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
      else if (!go && raf) { cancelAnimationFrame(raf); raf = 0; }
    };
    new IntersectionObserver(([e]) => { seen = e.isIntersecting; wake(); }, { threshold: 0.3 }).observe(gw);
    document.addEventListener('visibilitychange', wake);
  }
}

// Antseed Desktop's loop: the app's own states, captured from the client's prototype, in turn, with a cursor, typing and two messages over
// them (sections.html, sections.css). Picks Kimi K3.1 in the model list, switches Private on, types a prompt, sends it, a signed reply
// streams in; then it all goes back and starts again. Only while on screen; never with reduced motion (the first state stays)
const app = root.querySelector('.app');
if (app) {
  const k = app.querySelector('.app-k'), q = (c) => k.querySelector(c);
  new ResizeObserver(() => k.style.setProperty('--k', (app.clientWidth / 1100).toFixed(4))).observe(app);
  const [menu, kimi, priv, talk, typed, me, ai, sig, cur] = ['.menu', '.kimi', '.priv', '.talk', '.typed', '.me', '.ai', '.sig', '.cur'].map(q);
  const text = typed.querySelector('span'), reply = ai.querySelector('p');
  const PROMPT = 'Summarise this lease in three risks';
  const REPLY = 'Three risks stand out. The break clause lets the landlord end it after 12 months. The deposit is three months\' rent, above the usual. And you must give 90 days\' notice to leave.';
  let seen = false, run = 0;
  const on = (el, v = true) => el.classList.toggle('on', v);
  const move = (x, y) => { cur.style.setProperty('--cx', `${x}px`); cur.style.setProperty('--cy', `${y}px`); };
  const tap = async (go) => { cur.classList.add('tap'); cur.style.setProperty('--cs', .86); await wait(120); cur.style.setProperty('--cs', 1); await wait(120); cur.classList.remove('tap'); };
  const reset = () => { [menu, kimi, priv, talk, typed, me, ai, sig, cur].forEach((el) => on(el, false)); text.textContent = ''; reply.textContent = ''; move(880, 560); };
  async function loop(id) {
    const live = () => id === run && seen;
    reset(); await wait(600);
    while (live()) {
      on(cur); await wait(300); move(498, 806); await wait(900); if (!live()) break;      // to the model picker
      await tap(); on(menu); await wait(500); move(520, 732); await wait(950); if (!live()) break;   // the list, down to Kimi K3.1
      await tap(); on(menu, false); on(kimi); await wait(600); move(724, 332); await wait(1000); if (!live()) break;   // Kimi picked; to Private
      await tap(); on(priv); await wait(900); move(430, 712); await wait(900); if (!live()) break;   // night, sunglasses; to the box
      await tap(); on(typed);
      for (let n = 1; n <= PROMPT.length && live(); n++) { text.textContent = PROMPT.slice(0, n); await wait(38 + Math.random() * 40); }
      await wait(350); move(984, 752); await wait(800); if (!live()) break;   // to send
      await tap(); on(typed, false); text.textContent = ''; on(talk); await wait(250); on(me); await wait(700);
      on(cur, false); on(ai);
      const words = REPLY.split(' ');
      for (let n = 1; n <= words.length && live(); n++) { reply.textContent = words.slice(0, n).join(' '); await wait(55 + Math.random() * 60); }
      on(sig); await wait(3600); if (!live()) break;
      // back to the start
      [me, ai, sig].forEach((el) => on(el, false)); await wait(400); [talk, priv, kimi].forEach((el) => on(el, false)); await wait(900);
      reply.textContent = ''; move(880, 560); await wait(800);
    }
  }
  if (!still) new IntersectionObserver(([e]) => { seen = e.isIntersecting; if (seen) loop(++run); else run++; }, { threshold: 0.3 }).observe(app);
}

// ── 2. the live routing window ───────────────────────────────────────────
const lr = root.querySelector('.lr');
if (lr) {
  const panel = lr.closest('.s-lr-panel'), wide = matchMedia('(min-width: 900px)');
  // the window is drawn at the design's size (1172.6 wide in a 1312 panel) and scaled to the panel
  const fit = () => panel.style.setProperty('--k', wide.matches ? Math.min(1, panel.clientWidth / 1310).toFixed(4) : 1);
  new ResizeObserver(fit).observe(panel); wide.addEventListener('change', fit);

  // the wires, in the diagram's own px: each tool's right edge, the side of your device, each provider's left edge
  const TOOLS = [82.05, 199.25, 316.55, 433.85], PROVS = [75.1, 197, 318.9, 440.9], HUB = { l: 450.3, r: 661.4, y: 258.45 };
  const TOOL_X = 258.9, PROV_X = 853.6, TRUNK = 118, R = 16;
  const bend = (x0, y0, xt, x1, y1) => {   // horizontal to the trunk, rounded, vertical, rounded, horizontal on
    const dir = Math.sign(x1 - x0), v = Math.sign(y1 - y0), r = Math.min(R, Math.abs(y1 - y0) / 2);
    if (!v) return `M${x0} ${y0}H${x1}`;
    return `M${x0} ${y0}H${xt - dir * r}Q${xt} ${y0} ${xt} ${y0 + v * r}V${y1 - v * r}Q${xt} ${y1} ${xt + dir * r} ${y1}H${x1}`;
  };
  const svg = lr.querySelector('.wires'), sq = (x, y) => `<rect x="${x - 3.3}" y="${y - 3.3}" width="6.6" height="6.6"/>`;
  svg.innerHTML = TOOLS.map((y) => `<path d="${bend(TOOL_X, y, TOOL_X + TRUNK, HUB.l, HUB.y)}"/>`).join('')
    + PROVS.map((y) => `<path d="${bend(HUB.r, HUB.y, PROV_X - TRUNK, PROV_X, y)}"/>`).join('')
    + [...TOOLS.map((y) => sq(TOOL_X, y)), ...PROVS.map((y) => sq(PROV_X, y)), sq(HUB.l, HUB.y), sq(HUB.r, HUB.y)].join('');
  const wires = [...svg.querySelectorAll('path')];

  // what the window says in each tab. Values in UI cards are placeholders (see the handoff list).
  const tools = [...lr.querySelectorAll('.tools .chip')], provs = [...lr.querySelectorAll('.provs .chip')];
  const keep = (els) => els.map((el) => el.innerHTML);
  const ROUTE = { tools: keep(tools), provs: keep(provs), toolsCap: 'Your tools', provsCap: 'Providers', hubT: 'Antseed on your device', hubL: 'Saved today' };
  const ico = '<span class="ico ink"><img src="/site/assets/home/icons/code.svg" alt=""></span>';
  const PROVIDE = {
    tools: ['A coding agent', 'A team gateway', 'A chat app', 'A research agent'].map((t) => `${ico}<p><b>${t}</b><span>buyer</span></p>`),
    provs: [['deepseek.svg', 'deepseek-v4-flash', 'on your GPU'], ['anthropic.svg', 'claude-haiku-5.5', 'your API capacity'], ['ant-mark.svg', 'your-router', 'your own router'], ['kimi.svg', 'kimi-k3-legal', 'your fine-tune']]
      .map(([i, m, s]) => `<img src="/site/assets/home/icons/${i}" alt=""><p><b>${m}</b><span>${s}</span></p><span class="state">picked</span>`),
    toolsCap: 'Buyers', provsCap: 'You sell', hubT: 'Antseed on your machine', hubL: 'Earned today',
  };
  // one request per step: [tool, provider, receipt]. The receipts follow the live site's wording.
  const dot = '<i></i>';
  const ROUTE_STEPS = [
    [0, 0, '0x7a…3f', '0.41s', 0.0021, 'claude-haiku-5.5', 'Claude Code'],
    [1, 1, '0x5e…a2', '0.38s', 0.0007, 'deepseek-v4.1-flash', 'OpenClaw'],
    [2, 2, '0x1c…9d', '0.52s', 0.0034, 'gemini-4-argon', 'Hermes'],
    [3, 3, '0x9b…07', '0.36s', 0.0012, 'kimi-k3', 'your app'],
  ].map(([t, p, id, ms, cost, model, tool]) => ({ t, p, cost,
    html: `<span class="ok">✓ signed &amp; served</span>${dot}<b>${model}</b> <span class="mu">for ${tool}</span>${dot}<span class="mu">provider</span> ${id}${dot}${ms}${dot}$${cost.toFixed(4)}` }));
  ROUTE_STEPS.splice(2, 0, { t: -1, p: -1, cost: 0, html: '<span class="mu">every response is signed by its provider and checked against the model fingerprint</span>' });
  const PROVIDE_STEPS = [
    { t: 0, p: 0, cost: 0.0021, html: '<span class="ok">✓ picked you</span>' + dot + '<span class="mu">on price · latency · reputation</span>' },
    { t: 1, p: 1, cost: 0.0007, html: '<span class="mu">you set your price</span>' + dot + '<span class="mu">buyers pay per request, settled in USDC</span>' },
    { t: 2, p: 2, cost: 0.0034, html: '<span class="ok">✓ signed &amp; served</span>' + dot + '<b>your-router</b> <span class="mu">for a chat app</span>' + dot + '+$0.0034' },
    { t: 3, p: 3, cost: 0.0012, html: '<span class="ok">✓ signed &amp; served</span>' + dot + '<b>kimi-k3-legal</b> <span class="mu">for a research agent</span>' + dot + '+$0.0012' },
  ];
  const rc = lr.querySelector('.rc'), hubV = lr.querySelector('.hub-v');
  const total = { route: 18.624, provide: 0 };
  let mode = 'route', step = 0, timer = 0;

  function show(s) {
    tools.forEach((c, k) => c.classList.toggle('on', k === s.t));
    provs.forEach((c, k) => c.classList.toggle('on', k === s.p));
    wires.forEach((w, k) => w.classList.toggle('on', k < 4 ? k === s.t : k - 4 === s.p));
  }
  async function next() {
    const steps = mode === 'route' ? ROUTE_STEPS : PROVIDE_STEPS, s = steps[step % steps.length];
    step++;
    rc.classList.add('out'); await wait(still ? 0 : 250);
    rc.innerHTML = s.html; rc.classList.remove('out');
    show(s);
    if (s.cost) { total[mode] += s.cost; hubV.textContent = '$' + total[mode].toFixed(4); }
  }
  function setMode(m) {
    mode = m; step = 0;
    const data = m === 'route' ? ROUTE : PROVIDE;
    tools.forEach((c, k) => { c.innerHTML = data.tools[k]; });
    provs.forEach((c, k) => { c.innerHTML = data.provs[k]; });
    lr.querySelector('.tools-cap').textContent = data.toolsCap;
    lr.querySelector('.provs-cap').textContent = data.provsCap;
    lr.querySelector('.hub-t').textContent = data.hubT;
    lr.querySelector('.hub-l').textContent = data.hubL;
    hubV.textContent = '$' + total[m].toFixed(4);
    lr.dataset.mode = m;
    lr.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
    clearInterval(timer); next(); start();
  }
  lr.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => b.dataset.mode !== mode && setMode(b.dataset.mode)));
  show(ROUTE_STEPS[0]); step = 1;
  // runs only while the window is on screen
  const start = () => { clearInterval(timer); if (!still && visible) timer = setInterval(next, 3200); };
  let visible = false;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) start(); else clearInterval(timer); }).observe(lr);
}

// ── Privacy and trust: the three levels in a row, then Trust, you can verify: four points, one panel ──
// A vertical tablist (a click, or the arrow keys, Home and End) beside the panels; the chosen panel fades in and micro.js plays its
// scene ('pv:select'). In the chosen panel a fine stippled thread frames its scene's main card ([data-pv-frame]) a few px outside its
// rounded box: dots a pixel wide, a sixth of the mosaic's step apart, green and grey mixed (the golden ratio picks which, so they never
// clump or repeat), faint. Two soft glints run clockwise round it and lift the dots they pass a little; with the pointer over the panel
// the thread brightens and a green hairline shows under its dots. The canvas sits in the panel under the scene, so the scene's menus
// and popovers cover the thread where they cross it. The dots stay put and only their light moves; the card is measured every frame,
// so the thread follows it as it floats or turns. On a new choice the canvas moves to the new panel and the thread slides from the old
// card's box to the new one's. Each chosen panel arrives again as it did the first time (card-unveil.js): plain, then its painting
// growing from the centre in the LED mosaic and its windows popping in.
// From 900px wide and 600 tall, where the list stands beside the panel, the page's scroll chooses: the section's frame (.s-pv-pin) sticks
// and the run after it (.s-pv-run) gives the page STEP of a screen's height per point, so scrolling down goes through the four in turn,
// then the page goes on; a click or the arrow keys scroll to their point's place in the run. Narrower (a phone, a tablet upright: the
// list over the panel would not fit a screen), or where the ant, the panel and the rail's foot are taller than the screen, so a held
// frame would cut the top of its screen off, the tabs stay plain, and every AUTO ms the next point is chosen, while the section is on
// screen and neither hovered nor focused.
// With reduced motion: no pinning and no auto-advance, plain tabs, the thread drawn still, without glints or slide
const pv = root.querySelector('.s-pv');
if (pv) {
  const sec = pv.closest('.s-priv'), list = pv.querySelector('.s-pv-list'), stage = pv.querySelector('.s-pv-stage');
  const pin = sec.querySelector('.s-pv-pin'), span = pin.parentElement, STEP = 0.8, roomy = matchMedia('(min-width: 900px) and (min-height: 600px)');
  // a phone: one point's screen with its line does not fit a phone's screen, so nothing holds: the four points
  // stand one under another, each its name and line over its painting and screen, all shown (.pv-stack, sections.css), each playing as it
  // comes into view (micro.js listens for pv:select)
  const stacked = matchMedia('(max-width: 760px)');
  let pinned = false, top = 0, step = 1, held = false, quiet = 0;   // span: the frame and its run (.s-pv-hold); top: the frame's sticky top (above 0 when it is taller than the screen); held: a scroll of ours under way
  let replay = null;
  import('./card-unveil.js').then((m) => { replay = m.replay; }).catch(() => {});
  const tabs = [...list.querySelectorAll('[role="tab"]')], panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));
  const cards = panels.map((p) => p.querySelector('[data-pv-frame]'));
  const cv = Object.assign(document.createElement('canvas'), { className: 's-pv-dots' }), ctx = cv.getContext('2d');
  cv.setAttribute('aria-hidden', 'true');
  // GAP: the dots' pitch; DOT: their radius; LEAD and TAIL: a glint's soft rise ahead of its peak and its fade behind; EASE: the hover's
  // fade in and out, in ms; LV: the alpha steps the dots are batched into
  const GAP = 15.45 / 6, OFF = 7, DOT = 0.5, LEAD = 18, TAIL = 70, SPEED = 52, EASE = 280, LV = 12, SLIDE = 520, AUTO = 7000;
  // the inks, green then grey: lime and a pale grey on the night landscapes; on the pale day ones lime would vanish, so a moss green and
  // a mid grey, a little stronger. rest: each ink's alpha at rest; top: what a glint lifts it to; line: the hover's hairline (rgb, alpha)
  const INK = { dark: { dot: ['#c8f53c', '#c6cec8'], rest: [0.34, 0.2], top: [0.8, 0.45], line: ['200, 245, 60', 0.3] },
    light: { dot: ['#4a7419', '#76807a'], rest: [0.52, 0.32], top: [0.9, 0.55], line: ['74, 116, 25', 0.38] } };
  let cur = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'), from = null, t0 = 0, run = 0, last = 0, raf = 0, seen = false, W = 0, H = 0;
  let over = false, hp = 0;   // the pointer over the panel, and the hover's progress, 0 to 1
  // the card's box in its panel's px: centre, size, corner radius and turn, all as drawn (the stage is scaled, the card may be turned)
  function box(i) {
    const el = cards[i], st = el && el.offsetParent;
    if (!el || !st || !st.offsetWidth) return null;
    const pr = panels[i].getBoundingClientRect(), r = el.getBoundingClientRect(), k = st.getBoundingClientRect().width / st.offsetWidth;
    const cs = getComputedStyle(el), a = (parseFloat(cs.rotate) || 0) * Math.PI / 180;
    return { cx: r.left + r.width / 2 - pr.left, cy: r.top + r.height / 2 - pr.top, w: el.offsetWidth * k + 2 * OFF, h: el.offsetHeight * k + 2 * OFF,
      r: (parseFloat(cs.borderTopLeftRadius) || 0) * k + OFF, a };
  }
  // a rounded box's outline: its length P, and at(s), the point at length s along it, clockwise from the top left corner's end
  function outline({ cx, cy, w, h, r, a }) {
    r = Math.min(r, w / 2, h / 2);
    const q = r * Math.PI / 2, sides = [w - 2 * r, q, h - 2 * r, q, w - 2 * r, q, h - 2 * r, q], P = sides.reduce((p, v) => p + v, 0);
    const x0 = -w / 2, y0 = -h / 2, c = Math.cos(a), n = Math.sin(a);
    const arc = (ax, ay, f, s) => { const t = f + s / r; return [ax + r * Math.cos(t), ay + r * Math.sin(t)]; };
    const at = (s) => {
      s = ((s % P) + P) % P;
      let k = 0; while (k < 7 && s > sides[k]) { s -= sides[k]; k++; }
      let p;
      switch (k) {
        case 0: p = [x0 + r + s, y0]; break;
        case 1: p = arc(-x0 - r, y0 + r, -Math.PI / 2, s); break;
        case 2: p = [-x0, y0 + r + s]; break;
        case 3: p = arc(-x0 - r, -y0 - r, 0, s); break;
        case 4: p = [-x0 - r - s, -y0]; break;
        case 5: p = arc(x0 + r, -y0 - r, Math.PI / 2, s); break;
        case 6: p = [x0, -y0 - r - s]; break;
        default: p = arc(x0 + r, y0 + r, Math.PI, s);
      }
      return [cx + p[0] * c - p[1] * n, cy + p[0] * n + p[1] * c];
    };
    return { P, at };
  }
  const smooth = (x) => x * x * (3 - 2 * x);
  // the canvas in the chosen panel, under its scene, as large as the panel
  function place() {
    const p = panels[cur], scene = p.querySelector('[data-mi]') || p.firstElementChild;
    if (cv.parentNode !== p) p.insertBefore(cv, scene);
    const dpr = devicePixelRatio || 1;
    W = p.offsetWidth; H = p.offsetHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function draw(now) {
    const to = box(cur);
    ctx.clearRect(0, 0, W, H);
    if (!to) return;
    let b = to;
    if (from && !still) {
      const k = Math.min(1, (now - t0) / SLIDE), e = 1 - (1 - k) ** 3, mix = (key) => from[key] + (to[key] - from[key]) * e;
      b = { cx: mix('cx'), cy: mix('cy'), w: mix('w'), h: mix('h'), r: mix('r'), a: mix('a') };
      if (k === 1) from = null;
    }
    const ink = INK[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'], hov = smooth(hp);
    const { P, at } = outline(b), n = Math.max(24, Math.round(P / GAP)), step = P / n, head = run % P;
    const gain = (devicePixelRatio || 1) < 1.5 ? 1.3 : 1;   // on a 1x screen a pixel-wide dot spreads over several pixels and fades
    const dots = Array.from({ length: 2 * LV }, () => new Path2D()), line = hov > 0.01 ? new Path2D() : null;
    for (let i = 0; i < n; i++) {
      const s = i * step, [x, y] = at(s), g = (i * 0.6180339887) % 1 < 0.45 ? 0 : 1;   // 0 green, 1 grey
      let lit = 0;
      // how far each glint's peak is past this dot: behind the peak the light fades over TAIL px, ahead of it it rises over LEAD
      if (!still) for (const off of [0, P / 2]) {
        const d = (((head + off - s) % P) + P) % P;
        lit = Math.max(lit, d < TAIL ? smooth(1 - d / TAIL) : d > P - LEAD ? smooth(1 - (P - d) / LEAD) : 0);
      }
      const rest = ink.rest[g] * (0.85 + 0.3 * ((i * 0.7548776662) % 1)) * (1 + 0.6 * hov);
      const al = Math.min(1, (rest + Math.max(0, ink.top[g] - rest) * lit) * gain), r = DOT * (1 + 0.3 * lit);
      const p = dots[g * LV + Math.max(0, Math.min(LV - 1, Math.round(al * LV) - 1))];
      p.moveTo(x + r, y); p.arc(x, y, r, 0, 2 * Math.PI);
      if (line) i ? line.lineTo(x, y) : line.moveTo(x, y);
    }
    if (line) { line.closePath(); ctx.strokeStyle = `rgba(${ink.line[0]}, ${ink.line[1] * hov})`; ctx.lineWidth = 0.6; ctx.stroke(line); }
    dots.forEach((p, k) => { ctx.globalAlpha = (k % LV + 1) / LV; ctx.fillStyle = ink.dot[(k / LV) | 0]; ctx.fill(p); });
    ctx.globalAlpha = 1;
  }
  function frame(now) {
    raf = 0;
    if (!seen || document.hidden) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    run += SPEED * dt;
    hp = Math.max(0, Math.min(1, hp + (over ? 1 : -1) * dt * 1000 / EASE));
    draw(now); wake();
  }
  function wake() { if (!raf && !still && seen && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  const redraw = () => { place(); draw(performance.now()); };
  // the auto-advance
  let timer = 0;
  const hold = () => pv.matches(':hover') || pv.matches(':focus-within');
  const tick = () => { clearTimeout(timer); timer = 0; if (!still && !pinned && !stacked.matches && seen && !document.hidden) timer = setTimeout(() => { if (!hold()) choose((cur + 1) % tabs.length); else tick(); }, AUTO); };
  // how: 'key' (the arrow keys: the tab takes the focus), 'scroll' (the page's scroll chose it), or none (a click, the timer)
  function choose(i, how) {
    if (stacked.matches) return;   // a phone: the four stand one under another, nothing to choose
    if (how === 'key') tabs[i].focus({ preventScroll: pinned });
    if (pinned && how !== 'scroll' && i !== cur) go(i);
    if (i !== cur) {
      from = box(cur); t0 = performance.now();
      tabs.forEach((t, k) => { const on = k === i; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
      panels.forEach((p, k) => { p.classList.toggle('on', k === i); p.inert = k !== i; });
      cur = i;
      place();
      replay?.(panels[i]);
      sec.dispatchEvent(new CustomEvent('pv:select', { detail: { panel: panels[i] } }));
      if (still) requestAnimationFrame(() => draw(0));
    }
    tick();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => choose(i));
    t.addEventListener('keydown', (e) => {
      const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault(); choose((to + tabs.length) % tabs.length, 'key');
    });
  });
  // the run: its length and the frame's sticky top, measured again whenever the frame or the screen changes size
  // the list kept at its tallest state (the chosen tab's line open), so the tabs and the panel under them never jump; each screen
  // scaled to fit its panel's height with 40px of painting round it (900 wide and up, where the panel has production's fixed height);
  // the ant's room above the panel; then the frame holds only where the ant, the panel and the rail's foot fit the screen
  const ant = stage.querySelector('.s-pv-ant'), wins = panels.map((p) => p.querySelector('.pv4-win'));
  function fit() {
    const open = (t) => t.querySelector(':scope > span');
    const sel = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    list.style.removeProperty('--pv-list-h');
    const closed = list.offsetHeight - (open(sel)?.offsetHeight ?? 0);
    const tallest = Math.max(0, ...tabs.map((t) => open(t)?.firstElementChild?.offsetHeight ?? 0));
    list.style.setProperty('--pv-list-h', `${Math.ceil(closed + tallest)}px`);
    const wide = matchMedia('(min-width: 900px)').matches, h = panels[0].clientHeight, w = panels[0].clientWidth;
    const k = wide ? Math.max(0.78, Math.min(1, (h - 80) / Math.max(...wins.map((x) => x?.offsetHeight || 1)), (w - 64) / Math.max(...wins.map((x) => x?.offsetWidth || 1)))) : 1;
    stage.style.setProperty('--pv-s', k.toFixed(3));
    const room = ant ? Math.ceil(stage.getBoundingClientRect().top - ant.getBoundingClientRect().top) + 8 : 160;
    sec.style.setProperty('--pv-ant', `${Math.max(0, room)}px`);
    return room;
  }
  function measure() {
    const room = fit(), foot = Math.min(120, Math.max(40, innerHeight * 0.1));
    pinned = !still && roomy.matches && room + stage.offsetHeight + foot + 8 <= innerHeight;
    sec.classList.toggle('pv-pin', pinned);
    if (!pinned) { sec.style.removeProperty('--pv-top'); sec.style.removeProperty('--pv-run'); return; }
    step = Math.max(1, Math.round(innerHeight * STEP)); top = Math.min(0, innerHeight - pin.offsetHeight);
    sec.style.setProperty('--pv-top', `${top}px`); sec.style.setProperty('--pv-run', `${step * tabs.length}px`);
  }
  // the point the scroll is at: how far the frame has run since it stuck, in steps (before it sticks, the first; past the run, the last)
  let ran = -1;   // the same, as last seen, kept across a resize
  function follow() {
    if (!pinned) return;
    ran = (top - span.getBoundingClientRect().top) / step;
    if (held) return;
    const i = Math.max(0, Math.min(tabs.length - 1, Math.floor(ran)));
    if (i !== cur) choose(i, 'scroll');
  }
  // to a point's place in the run, its middle; the scroll doesn't choose again until it has settled
  const settle = () => { clearTimeout(quiet); quiet = setTimeout(() => { held = false; follow(); }, 160); };
  function go(i) {
    held = true; settle();
    scrollTo({ top: scrollY + span.getBoundingClientRect().top - top + (i + 0.5) * step, behavior: 'smooth' });
  }
  addEventListener('scroll', () => { if (held) settle(); follow(); }, { passive: true });
  // a resize while the frame holds keeps the page at the same place in the run, so the point shown stays (the page above may have
  // grown or shrunk); outside the run the page stays where it is
  const relayout = () => {
    const was = pinned, at = ran;
    measure();
    if (was !== pinned) tick();
    if (was && pinned && at > 0 && at < tabs.length) {
      const y = scrollY + span.getBoundingClientRect().top - top + at * step;
      if (Math.abs(y - scrollY) > 1) scrollTo({ top: y, behavior: 'instant' });
    }
    follow();
  };
  new ResizeObserver(relayout).observe(pin);
  addEventListener('resize', relayout);
  roomy.addEventListener('change', relayout);
  measure();
  const shown = new WeakSet();
  const seeIo = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting || !stacked.matches || shown.has(e.target)) return;
    shown.add(e.target); sec.dispatchEvent(new CustomEvent('pv:select', { detail: { panel: e.target } }));
  }), { threshold: 0.35 });
  const stack = () => {
    const on = stacked.matches;
    sec.classList.toggle('pv-stack', on);
    panels.forEach((p, k) => { p.classList.toggle('on', on || k === cur); p.inert = !on && k !== cur; if (on) seeIo.observe(p); else seeIo.unobserve(p); });
    if (on) panels.forEach((p, k) => { if (k !== cur) p.removeAttribute('data-unveil'); });
    tick();
  };
  stack(); stacked.addEventListener('change', () => { stack(); relayout(); });
  pv.addEventListener('pointerleave', tick); pv.addEventListener('focusout', tick);
  // the pointer over the panel brightens the thread (a mouse or pen: a tap has no hover); still, it shows at once
  const hover = (on) => (e) => { if (e.pointerType === 'touch') return; over = on; if (still) { hp = on ? 1 : 0; draw(performance.now()); } };
  stage.addEventListener('pointerenter', hover(true)); stage.addEventListener('pointerleave', hover(false));
  place();
  new ResizeObserver(redraw).observe(stage);
  new IntersectionObserver(([e]) => { seen = e.isIntersecting; wake(); tick(); }, { threshold: 0.2 }).observe(pv);
  document.addEventListener('visibilitychange', () => { wake(); tick(); });
  document.addEventListener('themechange', () => draw(performance.now()));
  document.fonts.ready.then(() => { redraw(); relayout(); });
}

// ── 3. the theme switch ──────────────────────────────────────────────────
// Each button sets its mode with window.antseedTheme.set (the head script in index.html: it keeps the choice, sets <html data-theme>
// and dispatches 'themechange'); the pressed one follows antseedTheme.get, on load and on every 'themechange'. Without the head
// script it still switches the page, for this visit only
const themes = root.querySelector('.s-foot .theme');
if (themes) {
  const html = document.documentElement, dark = matchMedia('(prefers-color-scheme: dark)');
  let own = 'system';   // the mode, when there is no antseedTheme to keep it
  const mode = () => window.antseedTheme?.get?.() ?? own;
  const show = () => themes.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode())));
  const apply = () => { html.dataset.theme = own === 'system' ? (dark.matches ? 'dark' : 'light') : own; html.style.colorScheme = html.dataset.theme; document.dispatchEvent(new Event('themechange')); };
  themes.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    if (window.antseedTheme?.set) window.antseedTheme.set(b.dataset.mode);
    else { own = b.dataset.mode; apply(); }
    show();
  });
  dark.addEventListener('change', () => { if (!window.antseedTheme && own === 'system') apply(); });
  document.addEventListener('themechange', show);
  show();
}

// the app's screens: its Private mode in dark, as the backers' logos in index.html
const tint = () => { const dark = document.documentElement.dataset.theme === 'dark'; for (const i of root.querySelectorAll('img[data-dark]')) { i.dataset.light ||= i.getAttribute('src'); i.src = dark ? i.dataset.dark : i.dataset.light; } };
tint(); document.addEventListener('themechange', tint);

// the network's diagram, in one of two styles (data-net-style on the panel, or ?net=steps / ?net=map). "steps", the default
// : net-steps.js plays the five cards in turn. "map": net.js draws the painted board, data-net="still" one still frame of
// the five steps for captures, ?net-step=1 to 5 or all picks the frame
const netPanel = root.querySelector('.s-net-panel');
const netQuery = new URLSearchParams(location.search), netStep = netQuery.get('net-step');
if (netPanel && ['steps', 'map'].includes(netQuery.get('net'))) netPanel.dataset.netStyle = netQuery.get('net');
const netMap = netPanel?.dataset.netStyle === 'map';
const netStill = still || !netMap || netPanel?.dataset.net === 'still';
if (netPanel && netStep) netPanel.dataset.step = netStep;
// the three layers take the board's place when listed: the old board is not drawn under them
const netLayers = (document.body.dataset.parts || '').split(',').includes('layers');
if (netPanel && !netLayers) import(netMap ? './net.js' : './net-steps.js').then((m) => m.mount(netPanel, { still })).catch((err) => console.warn('network diagram not drawn', err));
// the network has one look for the launch, the illustrated one: no switch, no ?net-look
// the captions are its timeline: the beat playing lights its caption ('netbeat'), and each caption is a button that plays its beat.
// With reduced motion, or as a still (data-net), the board does not play, so neither
const netPoints = root.querySelector('.s-points');
if (netPanel && netPoints && !netStill) {
  const cells = [...netPoints.children];
  cells.forEach((c, i) => {
    c.setAttribute('role', 'button'); c.tabIndex = 0;
    c.addEventListener('click', () => netPanel.netJump?.(i));
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); netPanel.netJump?.(i); } });
  });
  netPanel.addEventListener('netbeat', (e) => {
    const b = e.detail.beat;
    netPoints.classList.toggle('playing', b >= 0);
    cells.forEach((c, i) => c.classList.toggle('on', i === b));
  });
  // under the caption playing, a bar filling as its beat goes, so one reads where the story is; from empty at the next
  netPanel.addEventListener('netprogress', (e) => {
    const { beat: b, p } = e.detail;
    cells.forEach((c, i) => c.style.setProperty('--beat', i === b ? p : 0));
  });
}
// the captions under it: each as wide as its longest line, so its cell centres the text itself, not a box wider than it
const caps = [...root.querySelectorAll('.s-points p')];
if (caps.length) {
  const hug = () => caps.forEach((p) => {
    p.style.width = ''; p.style.textWrap = '';   // balanced at its full width first, then held at its longest line, unbalanced, so it keeps those lines
    const left = p.getBoundingClientRect().left, walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let right = left;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) { const r = document.createRange(); r.selectNodeContents(n); for (const q of r.getClientRects()) right = Math.max(right, q.right); }
      else if (n.tagName === 'IMG') right = Math.max(right, n.getBoundingClientRect().right);
    }
    if (right > left) { p.style.width = `${Math.ceil(right - left) + 1}px`; p.style.textWrap = 'wrap'; }
  });
  document.fonts.ready.then(hug);
  new ResizeObserver(hug).observe(caps[0].closest('.s-points'));
}

// Private by design: the incognito ant. She idles in a loop (smiling, legs swinging); a click (or Enter)
// plays her laugh once, or one time in five a short pout, then she is back to the loop. Every film starts and ends on the same pose,
// so every hand-over is a plain cut: a click waits for the loop's end. HEVC with alpha in WebKit (Safari), VP9 with alpha elsewhere.
// Fetched as the section nears, played only while on screen; with reduced motion her still, and the click does nothing
{
  const btn = document.querySelector('.s-pv-ant'), clips = btn ? Object.fromEntries([...btn.querySelectorAll('video')].map((v) => [v.dataset.clip, v])) : null;
  if (btn && still) { btn.disabled = true; btn.setAttribute('aria-hidden', 'true'); btn.tabIndex = -1; }
  else if (btn) {
    const hevc = navigator.vendor === 'Apple Computer, Inc.' && clips.idle.canPlayType('video/mp4; codecs="hvc1"') !== '';
    const url = (n) => `/site/assets/home/ant-incognito-${n}${hevc ? '-hevc.mov' : '.webm'}`;
    let seen = false, busy = null;
    const show = (v, fade) => { for (const o of Object.values(clips)) { o.classList.toggle('fade', fade); o.classList.toggle('on', o === v); } };
    const idle = () => { if (seen && !busy) clips.idle.play().catch(() => {}); else clips.idle.pause(); };
    clips.idle.addEventListener('canplay', idle);   // in case it was asked to play before it could
    document.addEventListener('themechange', idle);
    // Every hand-over is a plain cut between two frames that are the same picture: the incoming film is already sitting on its frame 0
    // (sought while hidden, never at the switch), it is shown first, then played; nothing fades
    const seek0 = (v) => { if (v.currentTime) try { v.currentTime = 0; } catch {} };
    for (const [n, v] of Object.entries(clips)) if (n !== 'idle') v.addEventListener('ended', () => {
      busy = null; show(clips.idle, false); idle(); seek0(v);
    });
    // a click waits for the idle loop's end (at most 2 s), then the reaction takes over from the same pose
    btn.addEventListener('click', () => {
      if (busy || !seen) return;
      busy = clips[Math.random() < 0.2 ? 'frown' : 'laugh']; seek0(busy);
      clips.idle.loop = false;
      if (clips.idle.paused) clips.idle.dispatchEvent(new Event('ended'));
    });
    clips.idle.addEventListener('ended', () => {
      const v = busy; clips.idle.loop = true;
      if (!v) { idle(); return; }
      show(v, false); v.play().catch(() => { busy = null; show(clips.idle, false); idle(); });
      seek0(clips.idle);   // ready on its frame 0 for the way back
    });
    new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !clips.idle.src) for (const [n, v] of Object.entries(clips)) { v.preload = 'auto'; v.src = url(n); }
    }, { rootMargin: '600px 0px' }).observe(btn);
    new IntersectionObserver(([e]) => { seen = e.isIntersecting; if (!seen && busy) busy.pause(); idle(); }).observe(btn);
  }
}

// the Providers' two cards, moving (providers-live.js)
import('./providers-live.js').catch(() => {});
