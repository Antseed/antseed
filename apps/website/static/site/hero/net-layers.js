// How the network works, as ONE map of the whole system (after the call with the client: the diagram has to cover what
// Antseed is and does, dense but legible). Drawn into [data-nl]: hero/parts/layers.html (the homepage, data-cut="home") and
// layers-large.html (the network page, data-cut="network").
// Two structures, and the first one leads:
//   the three layers (the client's): 1 DHT peer discovery, 2 Payments & settlement on Base, 3 Trust & liquid inference with ANTS. The foot
//     strip is their key. Every caption on the board opens with its layer's numeral, so the five open layers nest under the three:
//     1 Discovery, 1 Transport, 2 Metering & payments, 3 Reputation, 3 Model verification (and 2 / 3 on Base's two rails)
//   the three places (what lives where): quiet names down the left edge, each with the page's line of what lives there:
//     On your machine (with your device's window under it), Between the peers (at the routes' height), On Base (at the slab)
// The picture: the DHT's mesh above (not a place: nothing of yours lives there), the peers in the middle, each on its own glass tile
// (buyers at the left, you in front; providers at the right, facing them; an independent auditor behind Provider C), Base below as one
// glass slab with a USDC rail and an ANTS rail. The client's example connections: a developer to Provider A; a team workspace to A and B; an
// AI agent to B and C.
// The homepage's cut is the same picture, lighter: no captions, no device window, no auditor.
// One clock moves everything, only while the board is on screen in a tab that shows. Its pictures (the wash, the ants, the seeds, the
// coins, the icons) are asked for only once the board is near the screen, in the theme that shows.
const NS = 'http://www.w3.org/2000/svg';
const A = new URL('/site/assets/home/', import.meta.url).href, PX = `${A}icons/pixel/`;

// the geometry of each cut, in stage pixels (1248 wide): the rows of peers step back by `pitch` up and `dx` right (the depth axis),
// Base's slab leans the same way; RY is how high on an ant its routes leave; `res` is where your budget waits on the USDC rail;
// `mesh` the DHT's peers, `links` the lines between them, `hit` the three your lookup reaches
const CUTS = {
  network: { W: 1248, H: 720, AH: 70, RY: 27, pitch: 72, dx: 72, feet: 408, bx: 360, px: 864, res: 480,
    mesh: [[300, 144], [496, 152], [544, 108], [604, 70], [664, 90], [704, 56], [744, 62]], links: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 4], [3, 5], [4, 5], [5, 6], [4, 6]], hit: [0, 1, 2],
    slab: { yb: 494, yf: 626, x1: 350, x2: 1216 }, usdc: 530, ants: 588, tabs: [32, 648, 1184] },
  home: { W: 1248, H: 560, AH: 58, RY: 29, pitch: 62, dx: 76, feet: 336, bx: 300, px: 900, res: 590,
    mesh: [[500, 112], [566, 76], [652, 106], [704, 60], [776, 92], [622, 46], [818, 64]], links: [[0, 1], [1, 2], [0, 2], [1, 5], [5, 3], [2, 3], [2, 4], [3, 4], [3, 6], [4, 6]], hit: [0, 1, 3],
    slab: { yb: 378, yf: 488, x1: 276, x2: 1216 }, usdc: 402, ants: 450, tabs: [32, 508, 1184] },
};
// the ants: each sprite's width per height and where its feet are in it (assets/home/net/make-sprites.py)
const POSE = { 'you-idle': [.6462, .5351], 'user-idle': [.6469, .5351], idle: [.6469, .5351], 'prov-idle': [.6794, .5089] };
// what your device scores a provider from
const SIG = [['analytics', 'History'], ['check', 'Model audits'], ['lock', 'Backing'], ['user', 'Identity']];
// the foot strip: the client's three layers [what it lights, his line, the homepage's plain name for it]
const TABS = [
  ['d t', 'DHT peer discovery', 'Find a provider'],
  ['m', 'Payments &amp; settlement on Base', 'Pay for what you use'],
  ['r v s', 'Trust &amp; liquid inference with ANTS', 'Back the ones you trust'],
];
const LOOP = 12000;   // your request, start to settled, ms
const FAIL = [24000, 19000];   // every 24 s, from the 19th, Provider B is offline for 5 s
const LABEL = {
  network: 'The Antseed network in one picture, in three layers and three places. On your machine: your device looks up provider addresses in the BitTorrent DHT, compares their offers and scores them against your bar; Provider A is selected, Provider B is below your bar and skipped, Provider C is eligible. Between the peers: a developer, a team workspace and an AI agent at the left, Providers A, B and C at the right, joined by direct, encrypted routes with no central Antseed server; requests go one way, responses come back, and you sign the running usage total. An independent auditor checks Provider C. On Base: a budget in USDC is reserved, the provider settles and the unused budget returns to you; ANTS is staked behind providers. Prompts and outputs never go onchain.',
  home: 'The Antseed network in one picture. Above, the BitTorrent DHT: your device looks up provider addresses there. In the middle, the peers: a developer, a team workspace and an AI agent at the left, Providers A, B and C at the right, joined by direct routes with no central Antseed server; requests go one way, responses come back. Below, Base: USDC pays for the work and ANTS is staked behind providers.',
};

const S = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.append(e); return e; };
const H = (tag, cls, parent, inner) => { const e = document.createElement(tag); if (cls) e.className = cls; if (inner != null) e.innerHTML = inner; if (parent) parent.append(e); return e; };
const f = (p) => p.map((v) => +v.toFixed(1)).join(' ');
// a pixel icon, drawn in the text's colour through its mask (asked for once the board is lit)
const ic = (name, base = PX) => `<i class="nl-ic" style="--i:url(${base}${name}.svg)"></i>`;
const mark = (el, o) => { if (o.g) el.dataset.g = o.g; if (o.p) el.dataset.p = o.p; if (o.f) el.dataset.f = o.f; if (o.b) el.dataset.b = ''; return el; };
// a caption's opening: its layer's numeral (the foot strip is the key), then its name
const lead = (n, name) => `<i class="n" aria-hidden="true">${n}</i><b>${name}</b> `;
const ease = (q) => (q < .5 ? 4 * q * q * q : 1 - (-2 * q + 2) ** 3 / 2);

const draw = (root) => {
  const FULL = root.dataset.cut === 'network';
  const C = CUTS[FULL ? 'network' : 'home'], K = C.dx / C.pitch;
  root.textContent = '';
  const stage = H('div', 'nl-stage', root);
  stage.style.width = `${C.W}px`; stage.style.height = `${C.H}px`;
  const svg = S('svg', { class: 'nl-svg', viewBox: `0 0 ${C.W} ${C.H}`, role: 'img', 'aria-label': LABEL[FULL ? 'network' : 'home'] }, stage);
  const html = H('div', 'nl-html', stage);

  // the peers. Each belongs to a place: you to your machine, the others to the space between the peers
  const buyers = [
    { id: 'you', name: 'You, a developer', pose: 'you-idle', p: 'machine' },
    { id: 'team', name: 'A team workspace', pose: 'user-idle', p: 'peers' },
    { id: 'agent', name: 'An AI agent', pose: 'idle', p: 'peers' },
  ].map((b, i) => ({ ...b, x: C.bx + i * C.dx, y: C.feet - i * C.pitch }));
  const provs = [
    { id: 'A', price: '$0.11/M', sig: [1, 1, 1, 1] },
    { id: 'B', price: '$0.094/M', sig: [1, 0, 0, 1], b: FULL },
    { id: 'C', price: '$0.13/M', sig: [1, 1, 1, 1], tee: true },
  ].map((p, i) => ({ ...p, p: 'peers', pose: 'prov-idle', flip: true, x: C.px + i * C.dx, y: C.feet - i * C.pitch }));
  // the independent auditor: not a buyer, so it stands apart, behind the provider it checks
  const aud = FULL ? { id: 'aud', name: 'Independent auditor', pose: 'user-idle', g: 'v', p: 'peers', x: 912, y: 184 } : null;
  const peers = [...buyers, ...provs, ...(aud ? [aud] : [])];
  const by = Object.fromEntries(peers.map((p) => [p.id, p]));
  // who talks to whom: [buyer, provider, how far up the provider it lands, how far down the buyer it leaves, its mark]. Two routes
  // never share an end: the second one leaves 9px lower and lands 9px higher
  const ROUTES = [['you', 'A', 0, 0], ['team', 'B', 0, 0, { b: FULL }], ['team', 'A', 9, 9], ['agent', 'C', 0, 0], ['agent', 'B', 9, 9, { b: FULL }], ...(FULL ? [['aud', 'C', 9, 0, { g: 'v' }]] : [])];

  // ---- drawn ----
  // a plate lying on the ground: its back edge x1..x2 at yb, its front edge at yf, leaning left as it comes forward; corners rounded
  const face = (x1, x2, yb, yf, r, dy = 0) => {
    const sh = K * (yf - yb), c = [[x1, yb + dy], [x2, yb + dy], [x2 - sh, yf + dy], [x1 - sh, yf + dy]];
    const toward = (a, b) => { const d = Math.hypot(b[0] - a[0], b[1] - a[1]), rr = Math.min(r, d / 2); return [a[0] + (b[0] - a[0]) * rr / d, a[1] + (b[1] - a[1]) * rr / d]; };
    return c.map((k, i) => `${i ? 'L' : 'M'}${f(toward(k, c[(i + 3) % 4]))} Q${f(k)} ${f(toward(k, c[(i + 1) % 4]))}`).join(' ') + 'Z';
  };
  const plate = (g, x1, x2, yb, yf, { r = 18, t = 6, shade = 26, cls = '' } = {}) => {
    const p = S('g', { class: `nl-pl ${cls}` }, g);
    S('path', { class: 'nl-pl-shade', d: face(x1, x2, yb, yf, r, shade) }, p);
    const slab = S('g', { class: 'nl-pl-slab' }, p);
    for (let k = t; k > 0; k -= 1.5) S('path', { d: face(x1, x2, yb, yf, r, k) }, slab);
    S('path', { class: 'nl-pl-face', d: face(x1, x2, yb, yf, r) }, p);
    return p;
  };
  const tile = (g, cx, cy, hw = 44, hd = 14) => plate(g, cx - hw + K * hd, cx + hw + K * hd, cy - hd, cy + hd, { r: 9, t: 4.5, shade: 9, cls: 'nl-tile' });
  const grp = (o = {}, parent = svg) => mark(S('g', {}, parent), o);
  const line = (d, parent = svg) => S('path', { d, fill: 'none' }, parent);

  const you = by.you, pa = by.A, RY = C.RY, HW = Math.round(C.AH * .34);
  // Base: the slab, its two rails, a point on them under each peer; you and the provider you use are linked down to it (one link
  // each, to the first rail, so nothing crosses what is written between the rails)
  mark(plate(svg, C.slab.x1, C.slab.x2, C.slab.yb, C.slab.yf, { r: 22, t: 7, shade: 22 }), { p: 'base' });
  const gU = grp({ g: 'm', p: 'base' }), gA = grp({ g: 's', p: 'base' });
  S('path', { class: 'nl-usdc', d: `M${you.x} ${C.usdc} L${by.C.x} ${C.usdc}` }, gU);
  S('path', { class: 'nl-ants', d: `M${you.x} ${C.ants} L${by.C.x} ${C.ants}` }, gA);
  const node = (g, x, y, kind, rx = 5.5, ry = 3.4) => S('ellipse', { class: `nl-node ${kind}`, cx: x, cy: y, rx, ry }, g);
  for (const p of [...buyers, ...provs]) {
    node(gU, p.x, C.usdc, 'usdc');
    if (p === you || p === pa) S('line', { class: 'nl-usdc nl-drop', x1: p.x, y1: p.y + 22, x2: p.x, y2: C.usdc - 4, opacity: .75 }, gU);
  }
  const hold = node(gU, C.res, C.usdc, 'usdc hold', 7.5, 4.6);   // where your budget waits, reserved, until the provider settles
  for (const p of [you, pa, by.agent, by.C]) node(gA, p.x, C.ants, 'ants');
  // the peers' tiles, back to front; the lime ring under the provider you picked
  const gT = grp();
  let ring;
  for (const p of [...peers].sort((a, b) => a.y - b.y)) {
    mark(tile(gT, p.x, p.y, p === you ? 52 : 44, p === you ? 16 : 14), p);
    if (p === pa) ring = mark(S('ellipse', { class: 'nl-ring', cx: p.x, cy: p.y, rx: 30, ry: 10 }, gT), { g: 'r d', p: 'peers' });
  }
  // the usage authorization's own lane, under the route you use
  const sigY = you.y - RY + 26;
  const sigWay = FULL ? mark(S('path', { class: 'nl-sig', d: `M${you.x + HW} ${sigY} L${pa.x - HW} ${sigY}` }, svg), { g: 'm', p: 'peers' }) : null;
  // the direct routes: the map's lime dotted line, its darker twin under it
  const gR = grp();
  const ways = {};
  for (const [b, p, up, down, o = {}] of ROUTES) {
    const d = `M${by[b].x + HW} ${by[b].y - RY + down} L${by[p].x - HW} ${by[p].y - RY - up}`, cls = `${b === 'you' ? '' : 'fine'}${o.b ? ' b' : ''}`;
    const m = { g: o.g || 't', p: 'peers' };
    mark(S('path', { class: `nl-route under ${cls}`, d }, gR), m);
    ways[b + p] = mark(S('path', { class: `nl-route ${cls}`, d }, gR), m);
  }
  // the DHT: its mesh, a point on the air under each seed; your lookup, hopping through three of its peers
  const gD = grp({ g: 'd' });
  const M = C.mesh;
  S('path', { class: 'nl-mesh', d: C.links.map(([a, b]) => `M${f(M[a])} L${f(M[b])}`).join(' ') }, gD);
  for (const [x, y] of M) S('ellipse', { class: 'nl-dot', cx: x, cy: y, rx: 4.2, ry: 2.4 }, gD);
  const CARD = { x: 32, y: 112, w: 208 };   // your device's window (the network page)
  const lookFrom = FULL ? [CARD.x + CARD.w, CARD.y + 28] : [you.x - 80, you.y - C.AH - 34];
  const stops = [lookFrom, ...C.hit.map((i) => [M[i][0], M[i][1] - 19])];
  let lookD = `M${f(stops[0])}`;
  const reach = [], probe = S('path', {}, svg);
  for (let i = 1; i < stops.length; i++) {
    const [a, b] = [stops[i - 1], stops[i]], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lookD += ` Q${f(i > 1 || FULL ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - d * .1] : [a[0] - 18, b[1] + 8])} ${f(b)}`;
    probe.setAttribute('d', lookD); reach.push(probe.getTotalLength());
  }
  probe.remove();
  const lookWay = S('path', { class: 'nl-look', d: lookD }, gD);   // not a route: addresses travel here, never a prompt, so it is drawn as the mesh is

  // ---- placed ----
  const put = (e, x, y, o = {}) => { e.style.left = `${x}px`; e.style.top = `${y}px`; if (o.w) e.style.setProperty('--w', `${o.w}px`); return mark(e, o); };
  const tag = (x, y, inner, o = {}) => put(H('p', `nl-tag ${o.cls || ''}`, html, inner), x, y, o);
  const cap = (x, y, w, inner, o = {}) => put(H('div', `nl-cap ${o.cls || ''}`, html, inner), x, y, { ...o, w });
  // a place: its name (a button, so the pointer or the keyboard lights that place alone) and, under it, what lives there
  const zone = (x, y, place, inner, w, says) => {
    const b = put(H('button', 'nl-zone', html, inner), x, y); b.type = 'button'; b.dataset.place = place;
    cap(x, y + 32, w, says, { cls: w ? '' : 'one', p: place });
    return b;
  };
  const pic = (cls, src, parent = html) => { const i = H('img', cls, parent); i.alt = ''; i.decoding = 'async'; Object.assign(i.dataset, src); return i; };
  const SEED = { day: 'net/seed-day.webp', night: 'net/seed-glow.webp' };
  const TEE = ic('net-tee-shield', `${A}v6/`);
  // the DHT's peers: the hero's seed
  const seeds = M.map(([x, y]) => put(pic('nl-seed', SEED), x - 8, y - 20.5, { g: 'd' }));
  // the ants, back to front; the providers turned to face the buyers
  for (const p of [...peers].sort((a, b) => a.y - b.y)) {
    const [w, fx] = POSE[p.pose], wd = w * C.AH;
    const img = put(pic(`nl-ant${p.flip ? ' flip' : ''}`, { ant: p.pose }), p.x - (p.flip ? 1 - fx : fx) * wd, p.y - .9919 * C.AH, p);
    img.style.width = `${wd}px`; img.style.height = `${C.AH}px`;
  }
  // their names, each on the outer side of its column, clear of the next peer's tile: a buyer's above it and to the left; a
  // provider's to its right, leading its signed listing's price, and under it the four signals your device reads
  const backing = {};
  for (const b of [...buyers, ...(aud ? [aud] : [])]) tag(b.x + 8, b.y - C.AH - 25, b.name, { ...b, cls: 'r' });
  for (const p of provs) {
    const lx = p.x + HW + 8, ly = p.y - C.AH + 18;
    tag(lx, ly, `Provider ${p.id}${p.tee && FULL ? TEE : ''}${FULL ? `<span class="nl-price">${p.price}</span>` : ''}`, { p: 'peers', b: p.b });
    if (!FULL && p !== pa) continue;   // the homepage keeps the markers beside the provider you back only
    const lit = SIG.filter((_, i) => p.sig[i]).map(([, n]) => n).join(', ');
    const sig = tag(lx, ly + 28, (FULL ? '' : 'Reputation') + SIG.map(([n], i) => (p.sig[i] ? ic(n) : `<s class="nl-no">${ic(n)}</s>`)).join(''), { cls: 'nl-sigs', g: 'r', p: 'peers', b: p.b });
    sig.setAttribute('role', 'img'); sig.setAttribute('aria-label', `Provider ${p.id}'s signals: ${lit}`); sig.title = `Provider ${p.id}'s signals: ${lit}`;
    backing[p.id] = sig.querySelectorAll('.nl-ic')[2];
  }
  const dht = FULL ? [(M[0][0] + M[1][0]) / 2, (M[0][1] + M[1][1]) / 2] : [1, 2, 3, 5].reduce((a, i) => [a[0] + M[i][0] / 4, a[1] + M[i][1] / 4], [0, 0]);
  tag(dht[0], dht[1] - (FULL ? 11 : 9), 'BitTorrent DHT', { cls: 'mono c', g: 'd' });

  const BASE = '<img class="nl-base" data-src="icons/base.svg" alt="">';
  let failTag = null;
  if (FULL) {
    // what lives where: the three places, down the left edge, each with the page's line
    zone(32, 32, 'machine', `${ic('laptop')}On your machine`, 208, 'Routing preferences, local history and your allow and block rules.');
    zone(32, 356, 'peers', `${ic('plug')}Between the peers`, 208, 'Requests and responses. The provider you chose can read the request it serves, unless it runs inside a verified TEE.');
    zone(32, 496, 'base', `${BASE}On Base`, 160, 'Deposits, payment authorizations, usage totals, stake and rewards. Prompts and outputs never go onchain.');
    // your device's window: the offers, compared here; each provider's score against your bar (a drawing, no number)
    const row = (name, v, verdict, cls = '') => `<b class="${cls}">${name}</b><i class="nl-meter ${cls}" style="--v:${v}%" aria-hidden="true"></i><em class="${cls}">${verdict}</em>`;
    put(H('div', 'nl-glass nl-card', html, `<h3>Compare offers on your device</h3><div class="nl-score"><span></span><span class="bar">Your bar</span><span></span>${
      row('Provider A', 80, 'Selected', 'ok')}${row('Provider B', 22, 'Skipped', 'skip')}${row('Provider C', 68, 'Eligible')}</div>`), CARD.x, CARD.y, { w: CARD.w, g: 'd r', p: 'machine' });
    // the open layers, each where it happens, each under its layer's numeral
    cap(288, 32, 184, `${lead(1, 'Discovery')}Finding peers and signed listings. Discovery carries addresses, not your prompts.`, { cls: 'num', g: 'd', f: 'd' });
    cap(384, sigY + 17, 0, `${lead(1, 'Transport')}Verified peers and encrypted traffic.`, { cls: 'num one', g: 't', f: 't' });
    cap(384, sigY + 41, 376, `${lead(2, 'Metering &amp; payments')}Signed usage and USDC settlement. After each response you sign the running total.`, { cls: 'num', g: 'm', f: 'm' });
    cap(1216, 32, 176, `${lead(3, 'Reputation')}Trust scoring and identity signals.<ul class="nl-key">${SIG.map(([n, l]) => `<li>${ic(n)}${l}</li>`).join('')}</ul>`, { cls: 'num ra', g: 'r', f: 'r' });
    cap(aud.x - 70, 124, 222, `${lead(3, 'Model verification')}Public audits of what is served. Knowledge Boundary Fingerprinting compares answers with the genuine model. Evidence is public.`, { cls: 'num ra', g: 'v', f: 'v' });
    // in the air between the peers
    cap(by.B.x - 36, by.agent.y - RY + 10, 0, 'No central Antseed server', { cls: 'one r', g: 't', p: 'peers' });
    failTag = tag(691, by.team.y - RY - 11, 'Provider B offline → choose Provider C', { cls: 'c fail', g: 't', p: 'peers' });   // on the route that is down, only while it is
    // on Base: the budget where it waits; under each rail, what the rail does
    cap(C.res + 20, C.usdc - 30, 0, 'A budget is reserved before the first request.', { cls: 'one', g: 'm', p: 'base' });
    cap(384, C.usdc + 14, 0, `${lead(2, 'USDC pays for the work.')}The provider settles on Base and the unused budget returns to you.`, { cls: 'num one', g: 'm', p: 'base' });
    cap(384, C.ants + 16, 0, `${lead(3, 'Stake ANTS → Get inference')}ANTS gives access to intelligence.`, { cls: 'num one', g: 's', p: 'base' });
  } else {
    zone(32, you.y - 36, 'machine', `${ic('laptop')}On your machine`, 0, 'Local routing · your rules');
    zone(820, 120, 'peers', `${ic('plug')}Between the peers`, 0, 'No central Antseed server');
    zone(32, C.slab.yb + 14, 'base', `${BASE}On Base`, 130, 'Prompts and outputs never go onchain.');
    // under each rail, its name: the same kind of label, the same side; no coin passes behind either
    cap(C.res + 50, C.usdc + 14, 0, '<b>USDC pays for the work.</b>', { cls: 'one', g: 'm', p: 'base' });
    cap(C.res + 50, C.ants + 18, 0, '<b>Stake ANTS → Get inference</b>', { cls: 'one', g: 's', p: 'base' });
  }

  // ---- what travels ----
  // a token: what it is, its loop (ms), its legs [from, to, way, k0, k1] in the loop's own 0..1 (between two legs it waits where it
  // stopped), and `hold`, the moment it rests at when nothing moves. `pad`: a chip leaves from the ant's edge and stops at the
  // other's, so it never lies on either; `spin`: a seed turns to the way it travels
  const toks = [];
  const tok = (el, T, legs, o = {}) => { el.classList.add('nl-tok'); el.setAttribute('aria-hidden', 'true'); html.append(mark(el, o)); const t = { el, T, legs, at: 0, hold: null, ...o }; toks.push(t); return t; };
  const chip = (inner) => H('p', 'nl-chip', null, inner);
  const coin = (kind) => { const c = H('span', `nl-coin ${kind}`); pic('', { src: kind.startsWith('usdc') ? 'v6/net-nocrypto-usdc.svg' : 'ants-coin-cut.webp' }, c); return c; };
  const dot = (kind = '') => H('span', `nl-pip ${kind}`);
  const seed = () => pic('nl-grain', SEED, null);
  // you: the lookup goes up and the addresses come back; a budget is reserved; the request goes over, the response comes back; you
  // sign the running total; the provider takes it to Base (the authorization's ink, not money); the coin goes on to the provider and
  // the unused budget, a small coin, returns to you
  const look = tok(dot(), LOOP, [[0, .14, lookWay, 0, 1], [.14, .22, lookWay, 1, 0]], { g: 'd', hold: .09 });
  const payWay = line(`M${you.x} ${C.usdc} L${pa.x} ${C.usdc}`), kRes = (C.res - you.x) / (pa.x - you.x);
  tok(coin('usdc'), LOOP, [[.22, .30, payWay, 0, kRes], [.86, 1, payWay, kRes, 1]], { g: 'm', p: 'base', hold: .5 });
  tok(chip(`${ic('message')}Request →`), LOOP, [[.30, .48, ways.youA, 0, 1]], { g: 't', p: 'peers', hold: .3648, pad: true });
  tok(chip(`<img data-day="${SEED.day}" data-night="${SEED.night}" alt="">← Response`), LOOP, [[.48, .66, ways.youA, 1, 0]], { g: 't', p: 'peers', hold: .5448, pad: true });
  if (FULL) tok(chip('Usage authorization'), LOOP, [[.66, .80, sigWay, 0, 1]], { g: 'm', p: 'peers', hold: .73, pad: true });
  tok(dot('sig'), LOOP, [[.80, .86, line(`M${pa.x} ${pa.y + 22} L${pa.x} ${C.usdc}`), 0, 1]], { g: 'm', p: 'base' });
  tok(coin('usdc small'), LOOP, [[.86, 1, payWay, kRes, 0]], { g: 'm', p: 'base' });
  // ANTS, on its own rail: staked behind a provider, whose Backing lights. More than one user, more than one provider
  tok(coin('ants'), LOOP, [[.36, .62, line(`M${you.x} ${C.ants} L${pa.x} ${C.ants}`), 0, 1]], { g: 's', p: 'base', hold: FULL ? .46 : .477 });
  tok(coin('ants'), LOOP, [[.04, .28, line(`M${by.agent.x} ${C.ants} L${by.C.x} ${C.ants}`), 0, 1]], { g: 's', p: 'base', hold: FULL ? .19 : .199 });   // at rest the two coins stand apart, neither over a rail's name
  // a moment of the loop that lights something once: [from, to, element] (the ring swells, a Backing icon pulses, the point where
  // the budget waited lets its change go)
  const beats = [[.62, .72, ring], [.62, .72, backing.A], [.28, .38, backing.C], [.86, .96, hold]].filter(([, , el]) => el);
  // the other peers' answers come back to them, each on its own route; while Provider B is offline, its two come from A and from C
  [['teamA', .1, 7000], ['teamB', .55, 6200, 'teamA'], ['agentB', .3, 7600, 'agentC'], ['agentC', .8, 6600], ...(FULL ? [['audC', .45, 8200]] : [])]
    .forEach(([k, at, T, alt]) => tok(seed(), T, [[0, .5, ways[k], 1, 0]], { at, alt: FULL && alt ? ways[alt] : null, g: k === 'audC' ? 'v' : 't', p: 'peers', spin: true }));

  // ---- the three layers, along the foot: the key to the numerals above ----
  const tabs = put(H('div', 'nl-glass nl-tabs', html), C.tabs[0], C.tabs[1], { w: C.tabs[2] });
  tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'The three layers');
  const btns = TABS.map(([g, amos, plain], i) => {
    const b = H('button', '', tabs, `<i>${i + 1}</i>${FULL ? `<b>${amos}</b>` : `<b>${plain}</b><span>${amos}</span>`}`);
    b.type = 'button'; b.dataset.f = g; b.setAttribute('aria-pressed', 'false'); return b;
  });
  return { FULL, C, toks, look, reach, seeds, beats, btns, failTag };
};

const start = (root) => {
  if (!root || root.dataset.nlOn) return;
  root.dataset.nlOn = '1';
  const made = draw(root);
  const { C, toks, btns } = made;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fit = () => { const w = root.clientWidth; if (w) root.style.setProperty('--s', (w / C.W).toFixed(4)); };
  new ResizeObserver(fit).observe(root); fit();

  // the pictures, in the theme that shows; none is asked for before the board is near the screen (lit): the wash and the icons wait
  // in the sheet ([data-lit]), the rest here
  let lit = false;
  const src = (i, u) => { if (i.getAttribute('src') !== u) i.src = u; };
  const tint = () => {
    if (!lit) return;
    const t = document.documentElement.dataset.theme === 'dark' ? 'night' : 'day';
    for (const i of root.querySelectorAll('img[data-ant]')) src(i, `${A}net/ant-${i.dataset.ant}-${t}.webp`);
    for (const i of root.querySelectorAll('img[data-day]')) src(i, A + i.dataset[t]);
    for (const i of root.querySelectorAll('img[data-src]')) src(i, A + i.dataset.src);
  };
  const light = () => { if (!lit) { lit = true; root.dataset.lit = ''; tint(); } };

  // the clock: every token at `now` ms; null: nothing moves, each rests at its hold
  const len = new Map();
  const long = (way) => { if (!len.has(way)) len.set(way, way.getTotalLength()); return len.get(way); };
  let last = null, failing = false;
  const frame = (now) => {
    last = now;
    const frozen = now == null;
    // Provider B's turn offline (the network page): it dims, its two routes go grey, the line that says so shows on the one that is down
    const ft = frozen || !made.FULL ? -1 : now % FAIL[0] - FAIL[1], fail = ft >= 0;
    if (fail !== failing) { failing = fail; root.toggleAttribute('data-fail', fail); }
    const edge = fail ? Math.min(1, ft / 300, (FAIL[0] - FAIL[1] - ft) / 300) : Math.min(1, -ft / 300, (ft + FAIL[1]) / 300);   // a seed changing route fades through the change
    for (const t of toks) {
      const u = frozen ? t.hold : (((now / t.T - t.at) % 1) + 1) % 1, first = t.legs[0], end = t.legs[t.legs.length - 1], a = first[0], b = end[1];
      if (u == null || u < a || u > b) { t.el.style.opacity = 0; continue; }
      let leg = first;
      for (const l of t.legs) if (u >= l[0]) leg = l;
      // each leg eases in and out; a chip's leg is shorter by half the chip and 8px at both ends
      const way = t.alt && fail ? t.alt : leg[2], L = long(way), q = ease(Math.min(1, (u - leg[0]) / (leg[1] - leg[0])));
      if (t.pad && !t.w) t.w = t.el.offsetWidth;
      const pad = t.pad && t.w ? Math.min(.4, (t.w / 2 + 8) / L) : 0, lo = pad, hi = 1 - pad;
      const k = lo + (hi - lo) * (leg[3] + (leg[4] - leg[3]) * q), p = way.getPointAtLength(L * k);
      let turn = '';
      if (t.spin) { const p2 = way.getPointAtLength(L * Math.max(0, k - .02)); turn = ` rotate(${(Math.atan2(p2.y - p.y, p2.x - p.x) * 180 / Math.PI + 120).toFixed(0)}deg)`; }   // the seed's tip leads (it is drawn tip up and to the left)
      t.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)${turn}`;
      // it shows whole: it fades only over the first and the last 6% of its way
      const fin = (u - a) / ((first[1] - first[0]) * .06), fout = (b - u) / ((end[1] - end[0]) * .06);
      t.el.style.opacity = ((frozen ? 1 : Math.max(0, Math.min(1, fin, fout))) * (t.alt && !frozen ? Math.max(0, edge) : 1) * (t.el.classList.contains('off') ? .14 : 1)).toFixed(2);
    }
    // your lookup reaches three of the DHT's peers, one after the other
    const lu = frozen ? -1 : (now / LOOP) % 1, far = lu >= 0 && lu < .14 ? ease(lu / .14) * made.reach[made.reach.length - 1] : -1;
    made.reach.forEach((r, i) => made.seeds[C.hit[i]].classList.toggle('hit', far >= r - 6 && far < r + 40));
    for (const [a, b, el] of made.beats) el.classList.toggle('hit', lu >= a && lu < b);
  };

  // focus: a layer kept open by its button, a mechanism while the pointer rests on its caption, a place while it rests on its name.
  // The pointer has to rest (140 ms): crossing the board does not make it flicker
  let pinned = null, raf = 0, seen = false, wait = 0;
  const marked = [...root.querySelectorAll('[data-g], [data-p]')];
  const focus = (g, place) => {
    const set = g ? g.split(' ') : null;
    root.classList.toggle('focus', !!(set || place));
    for (const e of marked) {
      const off = place ? e.dataset.p !== place : !!set && !!e.dataset.g && !e.dataset.g.split(' ').some((t) => set.includes(t));
      e.classList.toggle('off', off);
    }
    if (!raf) frame(last);
  };
  const rest = (fn) => { clearTimeout(wait); wait = setTimeout(fn, 140); };
  const leave = () => { clearTimeout(wait); focus(pinned); };
  const pin = (g) => { clearTimeout(wait); pinned = g; btns.forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.f === pinned))); focus(pinned); };
  btns.forEach((b) => {
    b.addEventListener('click', () => pin(pinned === b.dataset.f ? null : b.dataset.f));
    b.addEventListener('pointerenter', () => rest(() => focus(b.dataset.f)));
    b.addEventListener('pointerleave', leave);
  });
  for (const c of root.querySelectorAll('.nl-cap[data-f]')) { c.addEventListener('pointerenter', () => rest(() => focus(c.dataset.f))); c.addEventListener('pointerleave', leave); }
  for (const z of root.querySelectorAll('.nl-zone')) {
    const on = () => focus(null, z.dataset.place);
    z.addEventListener('pointerenter', () => rest(on)); z.addEventListener('pointerleave', leave);
    z.addEventListener('focus', () => { if (z.matches(':focus-visible')) on(); }); z.addEventListener('blur', leave);
  }

  const tick = (now) => { raf = 0; if (!seen || document.hidden) return; frame(now); raf = requestAnimationFrame(tick); };
  // the board's own motion (the running dots) runs with the clock: only on screen, in a tab that shows
  const run = () => { const go = seen && !document.hidden && !still; root.toggleAttribute('data-run', go); if (go && !raf) raf = requestAnimationFrame(tick); };
  frame(null);
  document.fonts?.ready.then(() => { for (const t of toks) t.w = 0; if (!raf) frame(last); });   // a chip's width, once its face is in
  const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; if (seen) light(); run(); }, { threshold: .2 });
  io.observe(root);
  const near = new IntersectionObserver(([e]) => { if (e.isIntersecting) { near.disconnect(); light(); } }, { rootMargin: '800px 0px' });   // the pictures, a screen ahead
  near.observe(root);
  document.addEventListener('visibilitychange', run);
  document.addEventListener('themechange', tint);
  // for captures: board.ndAt({ focus: 1 | 2 | 3 | 'machine' | 'peers' | 'base', t: ms }) stops the loop and shows that moment
  // (no t: everything at rest), with a layer or a place in focus
  root.ndAt = root.nlAt = ({ focus: fo, t } = {}) => {
    io.disconnect(); seen = false; cancelAnimationFrame(raf); raf = 0; root.removeAttribute('data-run'); light();
    if (typeof fo === 'number') pin(btns[fo - 1]?.dataset.f ?? null); else { pin(null); if (fo) focus(null, fo); }
    frame(t ?? null);
  };
};

export default (el) => start(el.matches?.('[data-nl]') ? el : el.querySelector('[data-nl]'));
document.querySelectorAll('[data-nl]').forEach(start);
