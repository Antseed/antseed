// The network in three layers, animated (parts/net-stack.html, net-stack.css): parts.js calls default(slot) once the markup is in.
// Three steps, each one of Figma's frames (assets/network/diagram/step-N.svg, the layers' names in data-n). The drawing is inlined at
// the left, the three stacked; the frame's data window is taken out of the SVG and set in HTML at its right (window), one per step.
// A step plays its beats in order (the groups "Beat N · …"): each flow (a path named "Flow / …", drawn from its source to its
// destination) is revealed along its length by a mask, a dot riding its head; what follows it in the group (arrowhead, pill, label)
// shows once it has arrived; the window's block of the same rank lights and the earlier ones go quiet. After the last beat the step
// holds, then the next one fades in at the old slabs' height and its slabs lift into place.
// The three points under the board (the section's [data-nsk-go], in the page) are the controls: the current one is marked
// aria-current, a click holds that step and replays it; the loop starts again when the panel comes back on screen. Nothing runs
// while the panel or the tab is out of sight. With reduced motion each step shows complete and only the points change it.
// The drawing is shown well under Figma's size, so its upright labels and pills are enlarged in place to stay readable (fit).
const ART = new URL('/site/assets/network/diagram/', import.meta.url);
const NS = 'http://www.w3.org/2000/svg';
const STEPS = 3, GAP = 500, HOLD = 2500, FADE = 450, LIFT = 800;
// how far each slab is lifted in each step
const UP = { 'Slab / DHT': [0, -161, -161], 'Slab / Base': [0, 0, -161] };
// flows of one beat start 220 ms apart; where one must land before the others leave, the beat's flows in groups
const ORDER = { 'recognized usage': [[0], [1, 2, 3]], 'scores': [[0, 1, 2], [3]] };
// labels: a cube's name is drawn at least READ px high on screen, up to GROW times its size
const READ = 11, GROW = 1.75;
// a label grows from the side of its stack that faces the drawing's middle; these few from the side named (l, r, m)
const SIDE = { 'Pill / 10 USDC': 'l' };
// the gap between a cube's bottom corner and its name
const CUBE_GAP = 8;
// the view of each drawing once the window and the legend have left it (both now in the side panel): tight around the slabs,
// the cubes and their names, so the drawing takes the room they freed
const VIEW = '-12 112 1272 892';
// each step's name, at the top of its window
const NAMES = [['Discovery', 'Mainline DHT'], ['Payments', 'Base'], ['Trust', 'ANTS']];
const CANCEL = Symbol('cancel');
const ease = (p) => (p < .5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p));
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// Figma's window (the SVG group "Window": blocks "Step / …", each a bar, a title and rows of text and pills) as HTML: the same rows
// in the same order, a table's cells at Figma's columns, the tones kept as classes (q* quiet, l* lit)
function windowOf(svg, k) {
  const win = svg.querySelector('[data-n="Window"]');
  const out = h('div', 'nsk-w');
  out.style.setProperty('--lit', win.style.getPropertyValue('--lit'));
  const head = h('div', 'nsk-head');
  head.append(h('b', '', NAMES[k][0]), h('span', '', NAMES[k][1]));
  out.append(head);
  const blocks = [...win.querySelectorAll('.nsk-b')].map((b) => {
    const box = h('div', 'nsk-b');
    const cells = [];
    for (const t of b.querySelectorAll('text')) {
      const pill = t.closest('[data-n^="Pill"]'), sp = t.querySelector('tspan');
      const cell = { x: +sp.getAttribute('x'), y: +sp.getAttribute('y'), table: !!t.closest('[data-n="table"]') };
      if (pill) {
        const im = pill.querySelector('image');
        cell.x = +pill.querySelector('rect').getAttribute('x');
        cell.el = h('span', 'nsk-pill');
        if (im) cell.el.append(Object.assign(h('img'), { src: im.getAttribute('href'), alt: '', width: 14, height: 14 }));
        cell.el.append(t.textContent);
      } else cell.el = h('span', t.getAttribute('class') || '', t.textContent);
      cell.bold = t.getAttribute('font-weight') === '500';
      cells.push(cell);
    }
    cells.sort((a, c) => (Math.abs(a.y - c.y) > 8 ? a.y - c.y : a.x - c.x));   // row by row (a row's baselines differ by a fraction), left to right
    let row = null, y = -99;
    for (const c of cells) {
      if (c.y - y > 8) {
        row = h('div', c.bold && !box.children.length ? 'nsk-t' : c.table ? 'nsk-r nsk-cols' : 'nsk-r');
        box.append(row); y = c.y;
      }
      if (c.table) c.el.style.left = `${((c.x - 1280) / 335 * 100).toFixed(2)}%`;
      row.append(c.el);
    }
    out.append(box);
    return box;
  });
  win.remove();
  // the legend leaves the drawing for the foot of the window, at Figma's size (its own small drawing, cut to its box)
  // (each row: its symbol as a small drawing cut to it, then its words; two columns)
  const lg = svg.querySelector('[data-n="Legend"]');
  if (lg) {
    const foot = h('div', 'nsk-key');
    const marks = [...lg.children].filter((el) => el.tagName !== 'text').map((el) => { const bb = el.getBBox(); return { el, y: bb.y + bb.height / 2 }; });
    for (const t of lg.querySelectorAll('text')) {
      const y = +t.querySelector('tspan').getAttribute('y') - 4.26;
      const mini = document.createElementNS(NS, 'svg');
      for (const [a, v] of [['viewBox', `36 ${y - 8} 28 16`], ['width', 28], ['height', 16], ['fill', 'none'], ['aria-hidden', 'true']]) mini.setAttribute(a, v);
      for (const m of marks) if (Math.abs(m.y - y) < 9) mini.append(m.el);
      const row = h('span', 'nsk-k');
      row.append(mini, t.textContent);
      foot.append(row);
    }
    lg.remove();
    out.append(foot);
  }
  svg.setAttribute('viewBox', VIEW);
  out.dataset.step = k + 1;
  return { el: out, blocks };
}

export default async (slot) => {
  const root = slot.querySelector('[data-nsk]');
  if (!root || root.dataset.nskOn) return;
  root.dataset.nskOn = '1';
  const stage = root.querySelector('.nsk-stage'), side = root.querySelector('.nsk-side');
  const points = [...(slot.closest('section') || document).querySelectorAll('[data-nsk-go]')];
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // each point carries its step's progress: a thin bar along the top of its cell, where the board meets the row,
  // filled as the step plays, full once it has played
  const bars = points.map((p) => { const el = h('span', 'nsk-bar'); el.setAttribute('aria-hidden', 'true'); p.parentElement.prepend(el); return el; });
  const bar = (i, v) => bars[i]?.style.setProperty('--p', Math.min(1, v).toFixed(3));

  const texts = await Promise.all([1, 2, 3].map((n) => fetch(new URL(`step-${n}.svg`, ART)).then((r) => (r.ok ? r.text() : Promise.reject(r.status)))));
  await document.fonts.ready;   // the labels are measured below
  const steps = texts.map((t, k) => {
    const svg = document.importNode(new DOMParser().parseFromString(t, 'image/svg+xml').documentElement, true);
    svg.setAttribute('aria-hidden', 'true');
    // the files point at their images from where they are; inlined, the page is the base
    for (const im of svg.querySelectorAll('image[href]:not([href^="data:"])')) im.setAttribute('href', new URL(im.getAttribute('href'), ART).href);
    stage.append(svg);
    const win = windowOf(svg, k);
    side.append(win.el);
    return { ...prepare(svg, k), win: win.el, blocks: win.blocks };
  });

  function prepare(svg, k) {
    const defs = svg.querySelector('defs');
    const wait = [...svg.querySelectorAll('[data-n^="Links /"], [data-n="Scene · ports"]')];   // shown once the slabs are in place
    wait.forEach((el) => el.classList.add('nsk-i'));
    const slabs = Object.keys(UP).map((n) => ({ el: svg.querySelector(`[data-n="${n}"]`), up: UP[n] })).filter((s) => s.el);
    const beats = [...svg.querySelectorAll('g[data-n^="Beat"]')].map((g, b) => {
      const flows = [], lead = [];
      for (const el of [...g.children]) {
        el.classList.add('nsk-i');
        if ((el.dataset.n || '').startsWith('Flow /')) {
          const len = el.getTotalLength();
          const m = document.createElementNS(NS, 'mask'), id = `nsk${k + 1}-m${b}-${flows.length}`;
          for (const [a, v] of [['id', id], ['maskUnits', 'userSpaceOnUse'], ['x', -100], ['y', 0], ['width', 1500], ['height', 1100]]) m.setAttribute(a, v);
          const pen = document.createElementNS(NS, 'path');
          for (const [a, v] of [['d', el.getAttribute('d')], ['stroke', '#fff'], ['fill', 'none'], ['pathLength', 1], ['stroke-dasharray', '1 1'],
            ['stroke-width', (+el.getAttribute('stroke-width') || 1) + 8]]) pen.setAttribute(a, v);
          m.append(pen); defs.append(m);
          const dot = document.createElementNS(NS, 'circle');
          const ink = el.getAttribute('stroke');
          for (const [a, v] of [['r', 5], ['fill', /^#c8f53c$/i.test(ink) ? '#5F8A12' : ink], ['class', 'nsk-dot nsk-i nsk-h']]) dot.setAttribute(a, v);
          flows.push({ el, len, id, pen, dot, after: [], hops: [] });
        } else if (flows.length) flows.at(-1).after.push(el);
        else lead.push(el);
      }
      // a lookup's hops show as the line passes them: each one's place along its flow
      for (const f of flows) {
        f.hops = f.after.filter((el) => /^hop/.test(el.dataset.n || '')).map((el) => {
          const x = +el.getAttribute('cx'), y = +el.getAttribute('cy'); let best = 0, d = Infinity;
          for (let i = 0; i <= 200; i++) { const p = f.el.getPointAtLength(f.len * i / 200), q = (p.x - x) ** 2 + (p.y - y) ** 2; if (q < d) { d = q; best = i / 200; } }
          return { el, at: best };
        });
        f.after = f.after.filter((el) => !/^hop/.test(el.dataset.n || ''));
        g.append(f.dot);
      }
      const key = Object.keys(ORDER).find((w) => g.dataset.n.includes(w));
      const groups = (key && ORDER[key].every((gr) => gr.every((i) => flows[i])) && ORDER[key].flat().length === flows.length)
        ? ORDER[key].map((gr) => gr.map((i) => flows[i])) : [flows];
      return { g, flows, lead, groups };
    });
    return { svg, beats, wait, slabs, labels: labels(svg) };
  }

  // ---- the labels: what is enlarged, and about which point. Upright text, pills and score chips, taken in the stacks Figma sets
  // them in (a name over its note or its pill: same left or right edge, one under the other), each stack growing from the edge it is
  // aligned on (the side of its cube), a lone label from the side nearer the drawing's middle. The legend grows from its corner; the
  // slabs' names along their edge. Tiles and pools keep Figma's size (their text sits on a shape).
  function labels(svg) {
    const els = new Set([...svg.querySelectorAll('g[data-n^="Pill"], rect[data-n="score highlight"]')]);
    for (const t of svg.querySelectorAll('text:not([transform])')) {
      if (t.closest('[data-n="Legend"], [data-n^="Pill"]')) continue;
      const p = t.parentNode;
      els.add(p.children.length > 1 && [...p.children].every((c) => c.tagName === 'text') && !/^(Scene|Beat|Cube|Holders|Slab)/.test(p.dataset.n || '') ? p : t);
    }
    const items = [...els].map((el) => { const b = el.getBBox(); return { el, l: b.x, r: b.x + b.width, t: b.y, b: b.y + b.height, id: 0 }; });
    items.forEach((it, i) => { it.id = i; it.sx = 0; it.sy = 0; });
    // a cube's name sits under its cube, ending (buyers) or starting (providers) plumb with the cube's front edge, and
    // whatever Figma set under the name (a note, a pill, a score) moves with it: the same place in every step
    for (const cube of svg.querySelectorAll('[data-n^="Cube /"]')) {
      const name = items.find((it) => it.el.tagName === 'text' && cube.contains(it.el));
      const face = (end) => [...cube.children].find((c) => (c.getAttribute('fill') || '').endsWith(end))?.getBBox();
      const fl = face('-l)'), fr = face('-r)');
      if (!name || !fl || !fr) continue;
      const buyer = fl.x + fr.x < 1240, edge = buyer ? 'r' : 'l';
      // under the cube: a buyer's name ends, a provider's starts, plumb with the cube's front edge (where its two faces meet)
      const front = fl.x + fl.width, bottom = fl.y + fl.height;
      const dx = front - name[edge], dy = bottom + CUBE_GAP - name.t;
      const stack = [name];
      for (let more = true; more;) {
        more = false;
        const last = stack[stack.length - 1];
        const next = items.find((it) => !stack.includes(it) && Math.abs(it[edge] - name[edge]) < 8 && it.t > last.t && it.t < last.b + 24);
        if (next) { stack.push(next); more = true; }
      }
      for (const it of stack) { it.sx = dx; it.sy = dy; it.l += dx; it.r += dx; it.t += dy; it.b += dy; }
      name.cube = buyer ? 'r' : 'l';
    }
    const find = (i) => (items[i].id === i ? i : (items[i].id = find(items[i].id)));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], c = items[j];
      if ((Math.abs(a.l - c.l) < 7 || Math.abs(a.r - c.r) < 7) && Math.max(a.t, c.t) - Math.min(a.b, c.b) < 14) items[find(i)].id = find(j);
    }
    const stacks = new Map();
    items.forEach((it, i) => { const r = find(i); if (!stacks.has(r)) stacks.set(r, []); stacks.get(r).push(it); });
    const out = [...stacks.values()].map((st) => {
      st.sort((a, c) => a.t - c.t);
      const L = Math.min(...st.map((i) => i.l)), R = Math.max(...st.map((i) => i.r)), mid = (L + R) / 2;
      const side = st.map((i) => SIDE[i.el.dataset.n]).find(Boolean) || (mid < 560 ? 'r' : mid > 680 ? 'l' : 'm');
      // a cube's name grows about itself, from the edge facing its cube, so it never moves between steps
      const nm = st.find((i) => i.cube);
      if (nm) return { items: st, side: nm.cube, ax: nm[nm.cube], ay: (nm.t + nm.b) / 2, dx: 0, cube: true };
      return { items: st, side, ax: side === 'l' ? L : side === 'r' ? R : mid, ay: (st[0].t + st[0].b) / 2, dx: 0 };
    });
    const lg = svg.querySelector('[data-n="Legend"]'), lb = lg?.getBBox();
    const names = [...svg.querySelectorAll('[data-n^="Slab /"] > text[transform]')].map((el) => ({ el, size: +el.getAttribute('font-size') }));
    return { stacks: out, legend: lg && { el: lg, x: lb.x, y: lb.y + lb.height }, names };
  }
  function fit() {
    const scale = steps[0].svg.getScreenCTM()?.a || 1;
    const k = Math.max(1, Math.min(GROW, READ / (13 * scale)));
    for (const s of steps) {
      // where each stack lands once enlarged; at the right, a stack that would run into one nearer the drawing moves further out
      const box = (st) => ({ l: Math.min(...st.items.map((i) => st.ax + (i.l - st.ax) * k)) + st.dx, r: Math.max(...st.items.map((i) => st.ax + (i.r - st.ax) * k)) + st.dx,
        t: Math.min(...st.items.map((i) => st.ay + (i.t - st.ay) * k)), b: Math.max(...st.items.map((i) => st.ay + (i.b - st.ay) * k)) });
      const outer = s.labels.stacks.filter((st) => st.side === 'l' && st.ax > 860 && !st.cube).sort((a, c) => a.ax - c.ax);
      outer.forEach((st, n) => {
        st.dx = 0;
        for (const near of outer.slice(0, n)) { const a = box(near), c = box(st); if (c.l < a.r + 6 && c.t < a.b + 2 && a.t < c.b + 2) st.dx += a.r + 8 - c.l; }
      });
      for (const st of s.labels.stacks) for (const i of st.items) {
        const shift = i.sx || i.sy ? ` translate(${i.sx.toFixed(2)} ${i.sy.toFixed(2)})` : '';
        if (k > 1) i.el.setAttribute('transform', `translate(${(st.ax + st.dx).toFixed(2)} ${st.ay.toFixed(2)}) scale(${k.toFixed(3)}) translate(${(-st.ax).toFixed(2)} ${(-st.ay).toFixed(2)})${shift}`);
        else if (shift) i.el.setAttribute('transform', shift.trim());
        else i.el.removeAttribute('transform');
      }
      for (const n of s.labels.names) n.el.setAttribute('font-size', (n.size * Math.min(k, 1.4)).toFixed(2));
    }
  }
  fit();
  new ResizeObserver(fit).observe(stage);

  // ---- states
  const pen = (f, p) => {
    if (p >= 1) { f.el.removeAttribute('mask'); return; }
    f.el.setAttribute('mask', `url(#${f.id})`);
    f.pen.setAttribute('stroke-dashoffset', 1 - p);
  };
  const light = (s, b) => {   // the window at beat b: its block lit, the earlier ones quiet, the later ones not there yet
    const at = Math.min(b, s.blocks.length - 1);
    s.blocks.forEach((el, i) => { el.classList.toggle('nsk-h', i > at); el.classList.toggle('lit', i === at); });
  };
  const blank = (s) => {
    for (const bt of s.beats) {
      for (const el of bt.g.children) el.classList.add('nsk-h');
      for (const f of bt.flows) pen(f, 0);
    }
    s.blocks.forEach((el) => { el.classList.add('nsk-h'); el.classList.remove('lit'); });
  };
  const full = (s) => {
    for (const bt of s.beats) {
      for (const el of bt.g.children) el.classList.toggle('nsk-h', el.classList.contains('nsk-dot'));
      for (const f of bt.flows) pen(f, 1);
    }
    light(s, s.beats.length - 1);
  };
  const lifts = (s) => s.slabs.map((sl) => +(sl.el.getAttribute('transform')?.match(/translate\(0 (-?[\d.]+)/)?.[1] || 0));
  const rest = (s, lifted = 0, linked = true) => {
    for (const sl of s.slabs) lifted ? sl.el.setAttribute('transform', `translate(0 ${lifted[sl.el.dataset.n] || 0})`) : sl.el.removeAttribute('transform');
    s.wait.forEach((el) => el.classList.toggle('nsk-h', !linked));
  };
  let cur = 0;
  const show = (k) => {
    steps.forEach((s, i) => { s.svg.classList.toggle('on', i === k); s.svg.classList.remove('was'); s.win.classList.toggle('on', i === k); });
    points.forEach((p) => (+p.dataset.nskGo === k + 1 ? p.setAttribute('aria-current', 'step') : p.removeAttribute('aria-current')));
    bars.forEach((_, i) => bar(i, i < k ? 1 : 0));
    root.dataset.step = k + 1; cur = k;
  };

  // ---- the clock: time only passes while the panel is on screen and the tab is in front; a new run cancels the one before
  let gen = 0, seen = false, held = false, away = false, started = false;
  const live = () => seen && !document.hidden;
  const tween = (ms, g, fn) => new Promise((ok, no) => {
    let t = 0, last = null;
    const tick = (now) => {
      if (g !== gen) return no(CANCEL);
      if (live()) { if (last !== null) t += Math.min(now - last, 64); last = now; fn?.(Math.min(t / ms, 1)); if (t >= ms) return ok(); } else last = null;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // the step's bar under way: the share of its beats played, the beat in hand counted by how far its flows have run
  let along = 0;
  const step = (k, b, n, e) => { along = Math.max(along, (b + e) / n); bar(k, along); };
  const draw = async (f, g, onp = () => {}) => {
    f.el.classList.remove('nsk-h'); f.dot.classList.remove('nsk-h');
    const ms = Math.max(900, Math.min(1200, 700 + f.len * .8));
    await tween(ms, g, (p) => {
      const e = ease(p), at = f.el.getPointAtLength(f.len * e);
      pen(f, e); onp(e);
      f.dot.setAttribute('cx', at.x); f.dot.setAttribute('cy', at.y);
      for (const hp of f.hops) if (e >= hp.at) hp.el.classList.remove('nsk-h');
    });
    f.dot.classList.add('nsk-h');
    for (const el of [...f.hops.map((hp) => hp.el), ...f.after]) el.classList.remove('nsk-h');
  };
  const beat = async (s, b, g) => {
    const bt = s.beats[b], k = steps.indexOf(s), n = s.beats.length;
    light(s, b);
    step(k, b, n, 0);
    for (const [i, el] of bt.lead.entries()) { el.classList.remove('nsk-h'); if (i < bt.lead.length - 1) await tween(120, g); }
    for (const [j, group] of bt.groups.entries()) await Promise.all(group.map(async (f, i) => { if (i) await tween(220 * i, g); await draw(f, g, (e) => step(k, b, n, (j + e) / bt.groups.length)); }));
    step(k, b, n, 1);
  };
  const play = async (k, g) => {
    const s = steps[k];
    along = 0; bar(k, 0);
    // a step played again: what it shows fades out first, nothing is wiped at once
    if (s.beats.some((bt) => [...bt.g.children].some((el) => !el.classList.contains('nsk-h')))) {
      for (const bt of s.beats) for (const el of bt.g.children) el.classList.add('nsk-h');
      s.blocks.forEach((el) => el.classList.add('nsk-h'));
      await tween(350, g);
    }
    blank(s);
    await tween(350, g);
    for (let b = 0; b < s.beats.length; b++) { await beat(s, b, g); await tween(GAP, g); }
  };
  // from step a to step b: a's flows and links step back, b fades in over a with its slabs where a had them, a goes, the slabs
  // move, the links and ports come back
  // A is left as it stands, mid-flow or mid-lift (a click can come at any time): nothing jumps to its end first
  const turn = async (a, b, g) => {
    const A = steps[a], B = steps[b];
    for (const bt of A.beats) for (const el of bt.g.children) el.classList.add('nsk-h');
    A.wait.forEach((el) => el.classList.add('nsk-h'));
    await tween(300, g);
    const now = Object.fromEntries(A.slabs.map((sl, i) => [sl.el.dataset.n, lifts(A)[i]]));
    const from = B.slabs.map((sl) => sl.up[a] - sl.up[b] + (now[sl.el.dataset.n] || 0));
    blank(B);
    rest(B, Object.fromEntries(B.slabs.map((sl, i) => [sl.el.dataset.n, from[i]])), false);
    show(b); A.svg.classList.add('was');
    await tween(FADE, g);
    A.svg.classList.remove('was');
    await tween(FADE, g);   // A fades out under B before anything moves, so no slab of A trails behind
    if (from.some(Boolean)) await tween(LIFT, g, (p) => B.slabs.forEach((sl, i) => sl.el.setAttribute('transform', `translate(0 ${(from[i] * (1 - ease(p))).toFixed(2)})`)));
    rest(B);
    await tween(300, g);
  };
  // the step on show brought to rest from wherever it was stopped: its slabs glide home, its links fade back
  const settle = async (k, g) => {
    const s = steps[k], from = lifts(s);
    show(k);
    if (from.some(Boolean)) await tween(LIFT, g, (p) => s.slabs.forEach((sl, i) => sl.el.setAttribute('transform', `translate(0 ${(from[i] * (1 - ease(p))).toFixed(2)})`)));
    rest(s);
  };
  const run = async (k, loop) => {
    const g = ++gen;
    try {
      // the steps out of sight are put straight; the one on show is left as it stands and leaves (or replays) from there
      steps.forEach((s, i) => { if (i !== cur) { rest(s); full(s); } });
      if (k !== cur) await turn(cur, k, g); else await settle(k, g);
      for (;;) {
        await play(k, g);
        if (!loop) return;
        await tween(HOLD - GAP, g);
        const next = (k + 1) % STEPS;
        await turn(k, next, g);
        k = next;
      }
    } catch (err) { if (err !== CANCEL) throw err; }
  };

  // ---- start: step 1 complete under the fold, then played once the panel is seen
  steps.forEach(full);
  show(0);
  root.classList.add('nsk-ready');
  points[0]?.closest('.s-points')?.classList.add('nsk-row');   // from here the row shows which step is on
  points.forEach((p) => p.addEventListener('click', () => {
    const k = +p.dataset.nskGo - 1;
    if (still) { gen++; steps.forEach((s) => { rest(s); full(s); }); show(k); bar(k, 1); return; }
    held = true; away = false; started = true;
    run(k, false);
  }));
  if (still) return;
  blank(steps[0]);
  new IntersectionObserver(([e]) => {
    const was = seen;
    seen = e.isIntersecting;
    if (!seen) { away = started; return; }
    if (was) return;
    if (!started) { started = true; run(0, true); } else if (held && away) { held = false; run(cur, true); }   // a held step loops again once the panel has left and come back
  }, { threshold: .35 }).observe(stage);
};
