// "Like BitTorrent, but for AI": the network drawn as it works, in SVG (.s-net-panel > svg.nd) over an isometric map of fields.
// The panel's painting is the map, seen from above at 30° with no vanishing point, like a game board; the pieces stand on its painted
// clearings, each the same size wherever it is, the lower on screen the more in front. Its pieces are ants on little round bases: you
// (the hero's mascot), the AI providers (the geek in round glasses, green bases) and other people (the amber ant in a blue bandana).
// Small seeds float over the fields, the hero's seed (Elio, 13 Nov: a seed, not a dot of light): the DHT, BitTorrent's address book that
// everyone shares. They run no models; they only point devices to providers. Nothing else joins them: a line is drawn only while
// something travels on it, or while a link is in use.
// Three rules keep it legible (Elio, 12 Nov: everything moved at once, one sign meant several things):
//   colour says whose it is: everything of yours in the site's lime (your lookup dotted, your links solid; Elio, 13 Nov: no blue), the
//   others' neutral, faint;
//   shape says what it is, the same for everyone: a request is a small white speech bubble, an answer the seed, a payment a USDC coin;
//   motion says the direction: one thing moves at a time, leaving from someone and landing at someone.
// One loop of LOOP ms tells your story in four beats (the captions under the board follow them, sections.js, through 'netbeat'):
//   1. find: you toss a lookup; it hops through three of the DHT's seeds, each flashing as it is reached; three providers ring and
//      keep a lime ring at their feet;
//   2. compare: each found provider shows its price under its base (one real text model's, models.json, in the Models section's
//      format); the cheapest is picked, its chip filled lime, and your link draws straight to it;
//   3. ask and pay, on that link: the request flies out, the provider catches it and tosses the answer back, you hug it as it lands,
//      then the payment flies to the provider, who bobs, glad. Each carries a small label on this first trip, the payment its value;
//   4. always on: that provider goes offline (grey, its chip says so, its link fades); your link draws to the next cheapest and a
//      quick request, answer and payment go by, only the payment labelled, with its value. (Antseed's docs: a failing provider is left out of routing; it is the
//      next request that goes elsewhere, not the one under way.)
//   then it rests on the whole picture, lets go, the provider comes back, and it starts again.
// Meanwhile the others stay quiet: now and then a faint link draws between another person and a provider (who may serve you too), holds
// a few seconds and fades, never more than two at once; the person bobs as it draws.
// The map is one painting per theme (sections.html: --wash, --wash-d); the pieces stand at SPOTS, fractions of the map kept per
// painting, one board for landscape and one for phones (fewer pieces, on a slice of the map), spread evenly over its painted clearings. Each pose of the ant is a sprite of its
// own (POSE, ROLE). It runs only while on screen, writes an attribute only when its value changes, and with reduced motion is one
// composed still: the prices with the one picked, your link, the answer on its way back, the lookup's path faint.
// The sprites are made by assets/home/net/make-sprites.py, the ant's poses cut from Hermès's paintings.
// Tags (an HTML layer over the board, .nd-ui): every ant wears its name, You, Provider or User (Elio, 13 Nov: each its tag); every piece,
// seed, chip and your links can be pointed at, focused (the first of each kind) or tapped, which shows what it is in one short sentence
// (TIP), in a card over the board.
const NS = 'http://www.w3.org/2000/svg';
const ART = '/site/assets/home/net/';
// the hero's seed, the one in its cursor, by day and at night (Elio, 13 Nov): the DHT's seeds and the answer you get back
const SEEDART = { day: '/site/assets/hero/seed-day.webp', night: '/site/assets/hero/seed-night.webp' };
const USDC = '/site/assets/home/v6/net-nocrypto-usdc.svg';
const LOOP = 22800, BREATH = 4560;   // the breath and the seeds' drift divide the loop, so nothing jumps when it starts again
// the camera: 30° above the ground, so a circle on it is half as high as wide (ISO), and a height stands at RISE of itself on screen
const ISO = 0.5, RISE = 0.866;
const NAME = { you: 'You', prov: 'Provider', user: 'User', dht: 'DHT peer', look: 'DHT lookup' };
// each a name, then its line, as the captions under the board
const TIP = {
  you: ['You', 'Your device. It finds providers on its own and pays each request directly.'],
  prov: ['Provider', 'Runs AI models on its own hardware and sells answers per request.'],
  user: ['User', 'Someone else on the network, reaching their own providers the same way.'],
  dht: ['DHT peer', 'A node of BitTorrent\'s DHT, the address book everyone shares. It runs no models; it points devices to providers.'],
  look: ['DHT lookup', 'Your device asks the DHT, peer by peer, where providers are. No central server.'],
  link: ['Direct link', 'Your device and a provider, encrypted, nobody between: request out, answer back, paid per request.'],
  price: ['Price', 'Each provider publishes its own price. Your device compares them and picks.'],
  off: ['Offline', 'A provider that stops answering is left out. Your next request goes to the next one.'],
};
// a price as the Models section writes it (sections.js usd(), per million tokens)
const usd = (v) => `$${v >= 0.1 ? v.toFixed(2) : +v.toPrecision(2)}/M`;
// what one request costs at a provider's price, for the coin's label: about 4,000 tokens, in USDC to two figures (Elio, 13 Nov: every
// payment shows its value, every time)
const paid = (price) => `${+(4000 * price / 1e6).toPrecision(2)} USDC`;
// the boards, one per map painting (assets/home/net/<map>-day.webp and -night.webp; the panel's --wash names the one shown, and the board
// is picked by that name; map-4, the still board's painting without five of the clearings, has no board of its own: the first one serves,
// its story boards standing on the clearings both paintings share). aspect: the painting's width per height. Then a board for landscape (wide) and one
// for phones (tall, on a slice of the map), each:
//   view: the part of the map the panel shows (its centre x, y and its height, in fractions of the map); size: an ant's height in px
//   on a map drawn 560px tall;
//   where the ants stand, on the painting's clearings, in fractions of the map ([x, y, facing: 1 right, -1 left]): you, the providers,
//   the others. map-2 has fifteen clearings, five across and three deep; the landscape board holds its nine pieces as a chequerboard
//   with one more in the middle, three in each row, so no corner or row is left bare (Elio, 13 Nov: one was missing top right); the
//   phone's slice shows six, all taken;
//   hops: the three DHT seeds your lookup goes through ([x, y] of the ground under each, and its height in px at that size), dht: how
//   many seeds in all (the rest scattered over the fields, clear of the pieces); found: the providers the lookup finds, in the order
//   they ring, and prices: theirs ($ per million tokens: around Claude Opus 5.5's lowest, $0.094, models.json 12 Nov);
//   others: the others' links ([person, provider, start ms, length ms], never more than two at once), stillOthers: the moment the
//   still shows of them.
const SPOTS = {
  'map-2': {
    aspect: 1584 / 672,
    wide: {
      view: [0.5, 0.5, 1], size: 80,
      you: [0.502, 0.837],
      // left to right: bottom left, top left, the middle, right of the middle, top right, and bottom right of the middle. The map's
      // four clearings nobody stood on are painted over (fields and bushes, Elio, 13 Nov); the two the phone's board uses get a piece
      provs: [[0.11, 0.836, 1], [0.114, 0.212, 1], [0.5, 0.503, -1], [0.7, 0.505, -1], [0.892, 0.21, -1], [0.698, 0.835, -1]],
      // bottom right, left of the middle, top middle, top right of the middle
      users: [[0.894, 0.837, -1], [0.316, 0.503, 1], [0.5, 0.212, -1], [0.693, 0.21, -1]],
      hops: [[0.4, 0.7, 70], [0.405, 0.34, 96], [0.6, 0.32, 92]], dht: 18, look: 1,
      found: [2, 3, 0], prices: [0.13, 0.094, 0.11],
      others: [[1, 1, 1500, 4500], [0, 5, 5000, 5500], [2, 2, 10500, 5500], [3, 4, 17000, 5000]], stillOthers: 7000,
    },
    tall: {
      view: [0.6, 0.5, 1], size: 64,
      you: [0.502, 0.837],
      provs: [[0.5, 0.212, 1], [0.7, 0.505, -1], [0.698, 0.835, -1]],
      users: [[0.693, 0.21, -1], [0.5, 0.503, 1]],
      hops: [[0.6, 0.72, 60], [0.6, 0.6, 96], [0.585, 0.36, 70]], dht: 8, look: 1,
      found: [0, 1, 2], prices: [0.13, 0.094, 0.11],
      others: [[0, 0, 1500, 5000], [1, 0, 11000, 5500]], stillOthers: 3000,
    },
    // the still story (data-net="still", amos-09): one request in five steps, fewer pieces, read left to right. You bottom left; the
    // three providers one above the other in the fourth column, so their prices read as a list; the two others past them on the right,
    // quiet. Your lookup climbs on your left through its three seeds, the only ones; your link crosses the board up to the cheapest (the
    // middle one), and when it goes down, along the bottom to the next. No line crosses another, and none passes an ant. lift: how high
    // your links arch
    wideStory: {
      view: [0.5, 0.5, 1], size: 80, story: true, lift: 0.1,
      you: [0.11, 0.836],
      provs: [[0.698, 0.835, -1], [0.7, 0.505, -1], [0.693, 0.21, -1]],
      users: [[0.892, 0.21, -1], [0.894, 0.837, -1]],
      hops: [[0.17, 0.6, 52], [0.25, 0.4, 64], [0.4, 0.3, 64]], dht: 3, look: 0,
      found: [1, 0, 2], prices: [0.094, 0.11, 0.13],
      others: [], stillOthers: 0,
    },
    // the phone's: the same, one person fewer, on the slice of the map right of its middle. The painting's two clearings in the
    // middle column are gone (map-4), so the slice is the providers' column on the left and the right-hand column beside it: you at
    // its foot, the one other user at its head, the lookup climbing in the gap between
    tallStory: {
      view: [0.77, 0.5, 1], size: 64, story: true, lift: 0.12,
      you: [0.894, 0.837],
      provs: [[0.698, 0.835, 1], [0.7, 0.505, 1], [0.693, 0.21, 1]],
      users: [[0.892, 0.21, -1]],
      hops: [[0.82, 0.68, 48], [0.8, 0.52, 60], [0.79, 0.36, 48]], dht: 3, look: 0,
      found: [1, 0, 2], prices: [0.094, 0.11, 0.13],
      others: [], stillOthers: 0,
    },
  },
};

// the ant's poses, painted: one sprite each, by day and by night (assets/home/net/ant-<pose>-day.webp, -night.webp; make-sprites.py),
// all facing right, each its own frame: w its width per height, fx, fy where its feet are in it (fractions from its left and top), k its
// height against the ant's
const POSE = {
  idle: { day: 'ant-idle-day', night: 'ant-idle-night', w: 0.6468, fx: 0.4844, fy: 0.9919, k: 1 },
  receive: { day: 'ant-receive-day', night: 'ant-receive-night', w: 0.6068, fx: 0.5139, fy: 0.9915, k: 1 },   // hugging the seed it caught, eyes closed in two happy arcs
  cheer: { day: 'ant-cheer-day', night: 'ant-cheer-night', w: 0.6453, fx: 0.4818, fy: 0.9915, k: 1 },         // arms up, mouth open
  send: { day: 'ant-send-day', night: 'ant-send-night', w: 0.6985, fx: 0.4925, fy: 0.9916, k: 1 },            // a toss, one arm out
};
// one ant a role (Elio, 12 Nov: the archetypes): you the mascot, a provider the geek, a user the amber ant in a bandana. A pose a role
// does not have is left out, so it stays itself (idle, still hopping and leaning) rather than turning into the mascot; you keep the mascot's
const ROLE = {
  you: { keep: true, idle: { day: 'ant-you-idle-day', night: 'ant-you-idle-night', w: 0.6462, fx: 0.5351, fy: 0.9919, k: 1 } },
  prov: { idle: { day: 'ant-prov-idle-day', night: 'ant-prov-idle-night', w: 0.6794, fx: 0.5089, fy: 0.9919, k: 1 } },
  user: { idle: { day: 'ant-user-idle-day', night: 'ant-user-idle-night', w: 0.6462, fx: 0.5351, fy: 0.9919, k: 1 } },
};
// the seed's width per length
const SEED = 470 / 651;

// your story, ms into the loop. 1 find: the toss, the lookup's hops (each from hop0 + k * hop, landing hopDur later), the providers
// ringing (from found, ring apart), the lookup letting go (lookOff). 2 compare: the prices (from chip, chipGap apart), the pick, your
// link drawn (linkDur). 3 ask and pay: the first trip (ask). 4 always on: the provider offline (off), the next one picked (repick),
// your link to it (relink), the quick trip (ask2). Then the rest, and the fade that lets everything go
const T = { toss: 300, hop0: 500, hop: 700, hopDur: 600, found: 2700, ring: 420, lookOff: 4300, chip: 4500, chipGap: 450, pick: 6000,
  link: 6400, linkDur: 700, ask: 7300, off: 15200, repick: 15800, relink: 16100, ask2: 16900, rest: 21500, fade: 22000 };
// where each caption's beat starts (Open market, Pay per request, Always on), and where the rest starts, when none is
const BEATS = [0, 7200, 15000, 21500];
// a trip, from its start: the request flies (fly) and stays where it lands for hold, so it can be read (Elio, 12 Nov), before the
// provider catches it; the provider tosses the answer at res, it flies back (back) and waits by you for hold before you hug it; you pay
// at pay, the coin flies (payFly) and waits by the provider for hold before it is taken. The first slow, with labels; the second quicker
const TRIP = { fly: 1600, hold: 700, res: 2600, back: 1600, pay: 5300, payFly: 1600 };
const QUICK = { fly: 900, hold: 450, res: 1600, back: 900, pay: 3200, payFly: 900 };
// the others' links: drawn in, held, let go
const O = { draw: 700, end: 700 };
// the still story: how much of itself a step taken before the one shown keeps, and one left behind by moving on
const FAINT = 0.4, LEFT = 0.18;
// the reactions: how long each lasts (ms)
const DUR = { receive: 1000, send: 600, bump: 560 };

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mod = (x, m) => ((x % m) + m) % m;
// a half sine from t0 over d (0 outside): a hop, a squash
const bump = (e, t0, d) => (e <= t0 || e >= t0 + d ? 0 : Math.sin(((e - t0) / d) * Math.PI));
const el = (tag, attrs, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.append(e);
  return e;
};
// a frame's write: only when the value changes, so a still part of the picture costs nothing
const put = (e, k, v) => { const c = e.$ || (e.$ = {}); if (c[k] !== v) { c[k] = v; e.setAttribute(k, v); } };
const style = (e, k, v) => { const c = e.$ || (e.$ = {}); if (c[k] !== v) { c[k] = v; e.style[k] = v; } };

export function mount(panel, { still = false } = {}) {
  // the board for the painting the panel shows (its --wash names the map), else the first
  const name = (/(map-[\w]+?)-day\./.exec(getComputedStyle(panel).getPropertyValue('--wash')) || [])[1];
  const board = SPOTS[name] || Object.values(SPOTS)[0];
  const svg = el('svg', { class: 'nd', role: 'img', 'aria-label': 'A network everyone shares, with no server in the middle. Small lights over the fields are the DHT, BitTorrent\'s shared address book. Your device asks it where providers are, compares the prices they publish and links straight to the cheapest: a request goes out, the answer comes back, and the request is paid for in USDC. When that provider goes offline, your next request goes to the next cheapest. Other people reach their own providers the same way.' });
  panel.prepend(svg);
  // the still story (amos-09): data-net="still" on the panel draws one frame of one request in five steps on its own board (SPOTS
  // wideStory, tallStory), data-step "1" to "5" the frame after that step, or "all" (the default) steps 1 to 4 at rest, each numbered
  // where it happens; the rail along the board's bottom (.nd-rail, sections.html) names them. Nothing loops. Without the attribute the
  // loop above plays again
  const story = panel.dataset.net === 'still', rail = panel.querySelector('.nd-rail');
  if (story) {
    still = true;
    svg.setAttribute('aria-label', 'One request in five steps. Your device looks up providers through the DHT, BitTorrent\'s shared address book; compares the prices they publish and picks the cheapest; talks to it directly, nobody between; pays it per request in USDC; and when it goes down, moves on to the next cheapest.');
  }
  const stepOf = () => { const k = panel.dataset.step; return /^[1-5]$/.test(k) ? +k : 0; };
  // the rail: the step shown in ink (all of them for all); it is a band under the map, which takes the panel's height above it
  const railOn = () => {
    const k = stepOf();
    if (rail) [...rail.children].forEach((li, i) => { li.classList.toggle('on', !k || i + 1 === k); if (i + 1 === k) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
    return story && rail ? Math.round(rail.offsetHeight) : 0;
  };
  let lastR = 0;
  // over the board: the tags, the prices, the labels and the targets to point at (rebuilt with the board), and the card that says what a thing is
  const ui = document.createElement('div'), tip = document.createElement('div');
  ui.className = 'nd-ui'; tip.className = 'nd-tip'; tip.id = 'nd-tip'; tip.setAttribute('role', 'tooltip');
  panel.append(ui);
  let scene = null, raf = 0, t0 = 0, from = 0, seen = false, lastW = 0, lastH = 0, beat = null, done = -1;

  // the card: over its target (a piece's head, a tag, a seed, or where the pointer met your link), or under it when there is no room
  // above, always inside the panel. Pointing shows it after a beat, at once while one is up; a tap pins it until the next tap
  let cur = null, timer = 0, goneAt = 0, lastType = 'mouse';
  const show = (target, ev) => {
    clearTimeout(timer);
    cur = target;
    // its sentence, balanced over its lines, and the card as wide as its longest line (a wrapped box keeps its widest size otherwise)
    tip.style.width = ''; const [name, line0] = TIP[target.dataset.tip]; const b = document.createElement('b'); b.textContent = name; tip.replaceChildren(b, ` ${line0}`);
    const range = document.createRange(), k = panel.offsetWidth / (panel.getBoundingClientRect().width || 1);
    range.selectNodeContents(tip);
    let line = 0;
    for (const r of range.getClientRects()) line = Math.max(line, r.width * k);
    const cs = getComputedStyle(tip), edge = tip.offsetWidth - tip.clientWidth + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    if (line) tip.style.width = `${Math.ceil(line + edge)}px`;
    const W = panel.clientWidth, H = panel.clientHeight, w = tip.offsetWidth, h = tip.offsetHeight, m = 8;
    let a = target.$a;
    if (!a) { const r = panel.getBoundingClientRect(), x = ev ? ev.clientX - r.left : W / 2, y = ev ? ev.clientY - r.top : H / 2; a = { x, top: y - 10, bottom: y + 10 }; }
    let top = a.top - h - m;
    if (top < m) top = Math.min(H - h - m, a.bottom + m);
    const left = Math.min(W - w - m, Math.max(m, a.x - w / 2));
    tip.style.transform = `translate(${left.toFixed(0)}px, ${top.toFixed(0)}px)`;
    tip.classList.add('on');
  };
  const hide = () => { clearTimeout(timer); cur = null; goneAt = performance.now(); tip.classList.remove('on'); };
  const targetOf = (n) => (n && n.closest ? n.closest('[data-tip]') : null);
  panel.addEventListener('pointerdown', (e) => { lastType = e.pointerType; }, { passive: true });
  panel.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const t = targetOf(e.target);
    if (!t || t === cur) return;
    clearTimeout(timer);
    if (cur || performance.now() - goneAt < 300) show(t, e); else timer = setTimeout(() => show(t, e), 140);
  });
  panel.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return;
    const t = targetOf(e.target);
    if (!t || targetOf(e.relatedTarget) === t) return;
    clearTimeout(timer);
    if (cur && !cur.matches(':focus-visible') && !targetOf(e.relatedTarget)) timer = setTimeout(hide, 90);
  });
  panel.addEventListener('click', (e) => {
    const t = targetOf(e.target);
    if (!t) { if (cur) hide(); return; }
    if (t === cur && lastType === 'touch') hide(); else show(t, e);
  });
  panel.addEventListener('focusin', (e) => { const t = targetOf(e.target); if (t && t.matches(':focus-visible')) show(t); });   // the keyboard's focus, not a click's
  panel.addEventListener('focusout', (e) => { if (targetOf(e.target) === cur && !targetOf(e.relatedTarget)) hide(); });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cur) hide(); });
  document.addEventListener('pointerdown', (e) => { if (cur && !panel.contains(e.target)) hide(); }, { passive: true });

  const build = () => {
    const W = Math.round(panel.clientWidth), H0 = Math.round(panel.clientHeight);
    if (!W || !H0) return;
    lastW = W; lastH = H0;
    lastR = railOn();
    const H = H0 - lastR;
    hide();
    svg.replaceChildren();
    ui.replaceChildren(tip);
    svg.setAttribute('viewBox', `0 0 ${W} ${H0}`);
    const tall = W / H < board.aspect * 0.8;   // a phone's board, on a slice of the map
    panel.classList.toggle('nd-tall', tall);
    scene = layout(svg, ui, W, H, story ? (tall ? board.tallStory : board.wideStory) : tall ? board.tall : board.wide, board.aspect, tall);
    // the map under the board, placed where its spots expect it
    const m = scene.map;
    panel.style.backgroundSize = `${m.w.toFixed(1)}px ${m.h.toFixed(1)}px`;
    panel.style.backgroundPosition = `${m.x.toFixed(1)}px ${m.y.toFixed(1)}px`;
    frame(still ? scene.still : 0, still);
  };

  // the beat under way, told to the captions ('netbeat', detail.beat: 0 Open market, 1 Pay per request, 2 Always on, -1 none), and how
  // far into it the story is ('netprogress', detail.p from 0 to 1, in steps of a thousandth), for the bar under its caption
  const tell = (b, p) => {
    if (b !== beat) { beat = b; done = -1; panel.dispatchEvent(new CustomEvent('netbeat', { detail: { beat: b } })); }
    const q = b < 0 ? 0 : Math.round(p * 1000) / 1000;
    if (q !== done) { done = q; panel.dispatchEvent(new CustomEvent('netprogress', { detail: { beat: b, p: q } })); }
  };
  const beatOf = (t) => (t < BEATS[1] ? 0 : t < BEATS[2] ? 1 : t < BEATS[3] ? 2 : -1);
  const frame = (t, keep) => {
    if (!scene) return;
    if (story) {
      scene.step(stepOf());
      return;
    }
    scene.draw(t, keep);
    if (!still) { const b = beatOf(t); tell(b, b < 0 ? 0 : (t - BEATS[b]) / (BEATS[b + 1] - BEATS[b])); }
  };
  const tick = (now) => {
    if (!t0) { t0 = now - from; from = 0; }
    frame((now - t0) % LOOP);
    raf = requestAnimationFrame(tick);
  };
  const play = () => { if (!still && seen && scene && !raf) { t0 = 0; raf = requestAnimationFrame(tick); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };

  // for captures and checks: hold the frame at t ms into the loop (play() picks the loop up again)
  panel.netAt = (t) => { stop(); frame(t % LOOP); };
  // for the captions: go to the start of beat i (0, 1, 2) and play on from there
  panel.netJump = (i) => {
    if (still || BEATS[i] == null) return;
    if (raf) t0 = performance.now() - BEATS[i];
    else { from = BEATS[i]; frame(BEATS[i]); play(); }
  };
  new ResizeObserver(() => {
    if (Math.round(panel.clientWidth) === lastW && Math.round(panel.clientHeight) === lastH && scene) return;
    stop(); build(); play();
  }).observe(panel);
  if (story) {
    new MutationObserver(() => { if (railOn() !== lastR) build(); else frame(0); }).observe(panel, { attributes: true, attributeFilter: ['data-step'] });
    document.fonts.ready.then(() => frame(0));   // the numbers sit by their tags, measured once the fonts are in
  }
  new IntersectionObserver(([e]) => { seen = e.isIntersecting; if (seen) play(); else { stop(); hide(); if (!still) tell(-1, 0); } }, { threshold: 0.25 }).observe(panel);
}

// ── the drawing ─────────────────────────────────────────────────────────
function layout(svg, ui, W, H, B, MAP, tall) {
  // the map, covering the panel round the board's view
  const [vx, vy, vh] = B.view;
  const mh = Math.max(H / vh, W / MAP), mw = mh * MAP;
  const mx = Math.min(0, Math.max(W - mw, W / 2 - vx * mw)), my = Math.min(0, Math.max(H - mh, H / 2 - vy * mh));
  const u = mh / 560, A = B.size * u;   // the board's scale, and an ant's height, the same wherever it stands
  const P = ([fx, fy]) => ({ x: mx + fx * mw, y: my + fy * mh });
  // how far apart two points on the ground are, the depth counted at its true length
  const far = (a, b) => Math.hypot(b.x - a.x, (b.y - a.y) / ISO);

  // a piece: an ant on a thin round base (radius n.base, n.th thick), its feet a little up on the base's top
  const piece = (n, flip, i) => {
    n.flip = flip; n.h = A; n.phase = (i * 0.37) % 1;
    n.base = A * (n.kind === 'prov' ? 0.36 : 0.3); n.th = Math.max(2, 4 * u * RISE); n.feet = n.y - n.th * 0.6;
    n.zHead = n.th * 0.6 + A * 0.8; n.zMid = n.th * 0.6 + A * 0.45;
    n.ev = [];
    return n;
  };
  const you = piece({ ...P(B.you), kind: 'you' }, 1, 0);
  const provs = B.provs.map(([x, y, f], i) => piece({ ...P([x, y]), kind: 'prov' }, f, i + 1));
  const users = B.users.map(([x, y, f], i) => piece({ ...P([x, y]), kind: 'user' }, f, i + 7));
  const ants = [you, ...provs, ...users];
  const found = B.found.map((i, k) => Object.assign(provs[i], { price: B.prices[k] }));
  const [first, second] = found.slice().sort((a, b) => a.price - b.price);

  // curves: a quadratic from a to b over a control point c
  const at = (q, s) => { const v = 1 - s; return { x: v * v * q.a.x + 2 * v * s * q.c.x + s * s * q.b.x, y: v * v * q.a.y + 2 * v * s * q.c.y + s * s * q.b.y }; };
  const pathOf = (q) => `M${q.a.x.toFixed(1)},${q.a.y.toFixed(1)} Q${q.c.x.toFixed(1)},${q.c.y.toFixed(1)} ${q.b.x.toFixed(1)},${q.b.y.toFixed(1)}`;
  // the part of q from 0 to s (de Casteljau), to draw a dotted arc as it goes
  const part = (q, s) => ({ a: q.a, c: { x: q.a.x + (q.c.x - q.a.x) * s, y: q.a.y + (q.c.y - q.a.y) * s }, b: at(q, s) });
  // an arc through the air from a to b (their ground points), leaving at height za and landing at zb (px on screen): a parabola
  // standing straight up over the line between them on the ground, the farther apart the higher, its top kept inside the panel.
  // One that would stand edge on (the two nearly one above the other on screen) leans over toward the board's middle, so it still
  // reads as an arc
  const arc = (a, b, za, zb, lift) => {
    const A0 = { x: a.x, y: a.y - za }, B0 = { x: b.x, y: b.y - zb }, mid = { x: (A0.x + B0.x) / 2, y: (A0.y + B0.y) / 2 };
    const dx = b.x - a.x, dy = b.y - a.y, edge = (dy * dy) / (dx * dx + dy * dy || 1);
    let peak = Math.max(6 * u, lift * far(a, b) * RISE);
    const lean = (mid.x < W / 2 ? 1 : -1) * edge * edge;
    const make = (p) => ({ a: A0, b: B0, c: { x: mid.x + lean * p * 0.5, y: mid.y - 2 * p }, ga: { x: a.x, y: a.y }, gb: { x: b.x, y: b.y } });
    let q = make(peak);
    for (let i = 0; i < 24 && peak > 6 * u; i++) {
      let top = Infinity;
      for (let k = 1; k < 16; k++) top = Math.min(top, at(q, k / 16).y);
      if (top >= 0.045 * H) break;
      peak *= 0.88; q = make(peak);
    }
    return q;
  };
  // the point on the fields straight under s (the same x on screen; its y on the ground line between the two)
  const ground = (q, s) => ({ x: at(q, s).x, y: q.ga.y + (q.gb.y - q.ga.y) * s });
  // where a line meets an ant: at its side toward the other end, chest high, never over its head (Elio, 12 Nov); and the lines are drawn
  // under the pieces, so one passing another ant goes behind it
  const side = (n, m) => ({ x: n.x + ((m.ax ?? m.x) < n.x ? -1 : 1) * A * 0.34, y: n.y, kind: n.kind });

  // the DHT's seeds: the three your lookup goes through, then the others scattered over the fields at varied heights (the same on
  // every load), clear of the pieces, their tags and prices, the lookup's tag, and each other; each leaning its own way
  const light = ([gx, gy, z], i) => { const g = P([gx, gy]); return { x: g.x, y: g.y, z: z * u, ax: g.x, ay: g.y - z * u, phase: (i * 0.29) % 1, per: [4560, 5700, 7600][i % 3], tilt: ((i * 47) % 70) - 35, kind: 'dht' }; };
  const lights = B.hops.map(light);
  const hopNodes = [you, ...lights];
  const hops = lights.map((n, k) => { const m = hopNodes[k]; return arc(m.kind === 'dht' ? m : side(m, n), n, m.kind === 'dht' ? m.z : m.zMid, n.z, 0.25); });
  lights.forEach((n, k) => { n.land = T.hop0 + k * T.hop + T.hopDur; });
  const TAG = tall ? 18 : 20, pad = tall ? 14 : 24;
  const h0 = at(hops[B.look], 0.5), lx = Math.min(W - pad - 52, Math.max(pad + 52, h0.x)), ly = h0.y - 8 - TAG - 6;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const clear = (x, y) => x > 12 && x < W - 12 && y > 12 && y < H - 12
    && !(Math.abs(x - lx) < 64 && y > ly - 12 && y < ly + TAG + 24)
    && ants.every((n) => Math.abs(x - n.x) > A * 0.62 || y < n.feet - A * 1.2 || y > n.y + A * 0.55)
    && lights.every((l) => Math.hypot(x - l.ax, y - l.ay) > A * 1.05);
  for (let k = 0; k < 800 && lights.length < B.dht; k++) {
    const gx = 0.02 + rnd() * 0.96, gy = 0.12 + rnd() * 0.84, z = 22 + rnd() * 100, g = P([gx, gy]);
    if (clear(g.x, g.y - z * u)) lights.push(light([gx, gy, z], lights.length));
  }

  // your links, head to head through the air: to the cheapest, then to the next; and the others'
  const links = [first, second].map((n) => arc(side(you, n), side(n, you), you.zMid, n.zMid, B.lift ?? (tall ? 0.22 : 0.16)));
  const sessions = B.others.map(([ui, pi, start, dur]) => ({ user: users[ui], prov: provs[pi], start, dur, q: arc(side(users[ui], provs[pi]), side(provs[pi], users[ui]), users[ui].zMid, provs[pi].zMid, tall ? 0.2 : 0.15) }));

  // ── what the ants do, as events on the loop ({ t, kind, amp, to: whom it faces, rank: yours over the others' }) ──
  const on = (n, t, kind, amp = 1, to = null, rank = 2) => n.ev.push({ t, kind, amp, to, rank, wrap: rank < 2 });
  on(you, T.toss, 'send', 1, lights[0]);   // you toss the lookup
  found.forEach((n, k) => on(n, T.found + k * T.ring - 60, 'bump', 0.8));   // the providers found perk up as they ring
  const trips = [[T.ask, TRIP, 0], [T.ask2, QUICK, 1]].map(([t, D, k]) => {
    const n = k ? second : first;
    on(you, t - 260, 'send', 0.7, n);                                    // the request, sent
    on(n, t + D.fly + D.hold - 200, 'receive', 1, you);                  // it has landed and waited: a hop to catch it
    on(n, t + D.res - 260, 'send', 1, you);                              // the answer, tossed back
    on(you, t + D.res + D.back + D.hold - 200, 'receive', 1, n);         // it has landed and waited: you hug it
    on(you, t + D.pay - 260, 'send', 0.7, n);                            // the payment, tossed
    on(n, t + D.pay + D.payFly + D.hold - 80, 'bump', 0.8, you);         // it has landed and waited: the provider, glad
    return { t, D, k, prov: n, q: links[k] };
  });
  // the others: the person bobs as their link draws
  sessions.forEach((o) => on(o.user, o.start + 100, 'bump', 0.7, o.prov, 1));

  // ── the SVG, back to front ──
  const defs = el('defs', {}, svg);
  const radial = (id, stops) => { const r = el('radialGradient', { id }, defs); stops.forEach(([o, c, a]) => el('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, r)); };
  radial('nd-sh', [[0, 'var(--nd-shadow)', 1], [0.55, 'var(--nd-shadow)', 0.55], [1, 'var(--nd-shadow)', 0]]);
  // the seeds' glow at night, amber as the hero's seed in the hand (index.html, .cursor)
  radial('nd-glow', [[0, '#ffcf7a', 0.95], [0.3, '#ff9f3d', 0.5], [0.65, '#f07a24', 0.16], [1, '#e0641a', 0]]);
  // an offline provider, its colours drained
  const grey = el('feColorMatrix', { type: 'saturate', values: '1' }, el('filter', { id: 'nd-grey' }, defs));
  const g = (cls) => el('g', { class: cls }, svg);
  // the layers: the map, the ground (the rings, the shadows of what flies), the long lines (others' links, the lookup, yours) under the
  // pieces, so none crosses an ant (Elio, 12 Nov), the seeds, then what travels along the lines
  const gRing = g('nd-rings'), gFall = g('nd-fall'), gOther = g('nd-olink'), gLook = g('nd-look'), gLink = g('nd-link'), gNode = g('nd-nodes'), gDht = g('nd-dht'), gPk = g('nd-pk'), gHit = g('nd-hits');
  const ring = (n) => el('ellipse', { cx: n.x.toFixed(1), cy: n.y.toFixed(1), rx: 0, ry: 0, opacity: 0 }, gRing);
  const hopPaths = hops.map(() => el('path', {}, gLook));
  const head = el('circle', { r: (3.6 * u).toFixed(1), cx: -99, cy: -99, opacity: 0 }, gLook);
  sessions.forEach((o) => { o.path = el('path', { d: pathOf(o.q), pathLength: 1, opacity: 0 }, gOther); });
  // your links: a line, and round the stretch where something travels a wider glow of the same lime
  const linkPaths = links.map((q) => el('path', { d: pathOf(q), pathLength: 1, opacity: 0 }, gLink));
  const litPaths = links.map((q) => el('path', { class: 'lit', d: pathOf(q), pathLength: 1, 'stroke-dasharray': '0.12 2', opacity: 0 }, gLink));
  // and over everything a wide unseen stroke along each, to point at while it is drawn
  const linkHits = links.map((q) => el('path', { d: pathOf(q), 'data-tip': 'link', visibility: 'hidden' }, gHit));

  // a sprite in its day and its night colours (sections.css shows the one for the theme)
  const img = (href, x, y, w, h, parent, cls) => el('image', { href, x: x.toFixed(1), y: y.toFixed(1), width: w.toFixed(1), height: h.toFixed(1), ...(cls ? { class: cls } : {}) }, parent);
  const pair = (day, night, x, y, w, h, parent) => { img(`${ART}${day}.webp`, x, y, w, h, parent, 'day'); img(`${ART}${night}.webp`, x, y, w, h, parent, 'night'); };
  // the hero's seed, h tall, centred on 0 0, with its amber glow round it at night
  const seedOf = (h, parent) => {
    const w = h * SEED;
    el('circle', { class: 'nd-halo', r: (h * 0.95).toFixed(1), fill: 'url(#nd-glow)' }, parent);
    img(SEEDART.day, -w / 2, -h / 2, w, h, parent, 'day'); img(SEEDART.night, -w / 2, -h / 2, w, h, parent, 'night');
  };
  // a soft contact shadow on the ground, darkest under the feet
  const shadow = (n, rx, parent) => el('ellipse', { class: 'sh', cx: n.x.toFixed(1), cy: (n.y + 1).toFixed(1), rx: rx.toFixed(1), ry: (rx * ISO).toFixed(1), fill: 'url(#nd-sh)' }, parent);
  // a piece's base: a thin round disc on the ground, its edge a shade darker than its top (green under a provider, sections.css)
  const base = (n, parent) => {
    const rx = n.base, ry = rx * ISO, b = el('g', { class: 'nd-base' }, parent);
    el('ellipse', { class: 'side', cx: n.x.toFixed(1), cy: n.y.toFixed(1), rx: rx.toFixed(1), ry: ry.toFixed(1) }, b);
    el('rect', { class: 'side', x: (n.x - rx).toFixed(1), y: (n.y - n.th).toFixed(1), width: (2 * rx).toFixed(1), height: n.th.toFixed(1) }, b);
    el('ellipse', { class: 'top', cx: n.x.toFixed(1), cy: (n.y - n.th).toFixed(1), rx: rx.toFixed(1), ry: ry.toFixed(1) }, b);
  };
  // the ant, standing on its base: one group it moves by (hop, squash, lean, facing), and in it a group per pose, one shown at a time
  const ant = (n, parent) => {
    const body = el('g', {}, parent), poses = {}, role = ROLE[n.kind];
    for (const name in POSE) {
      const p = role ? role[name] || (role.keep ? POSE[name] : null) : POSE[name];
      if (!p) continue;
      const h = n.h * p.k, w = h * p.w, gp = el('g', name === 'idle' ? {} : { visibility: 'hidden' }, body);
      pair(p.day, p.night, -p.fx * w, -p.fy * h, w, h, gp);
      poses[name] = gp;
    }
    return { body, poses };
  };
  const view = new Map();
  // the pieces, the farther (higher on screen) first
  ants.slice().sort((a, b) => a.y - b.y).forEach((n) => {
    const grp = el('g', { class: `nd-n ${n.kind}` }, gNode);
    const sh = shadow(n, n.base * 1.25, grp);
    base(n, grp);
    view.set(n, { grp, sh, shr: n.base * 1.25, ...ant(n, grp), mark: n.price ? ring(n) : null, ping: n.price ? ring(n) : null });
  });
  // the seeds: the hero's, small, floating, each leaning its own way; moved and scaled as one
  lights.forEach((l) => {
    const grp = el('g', { transform: `translate(${l.ax.toFixed(1)} ${l.ay.toFixed(1)})` }, gDht);
    seedOf(A * (tall ? 0.28 : 0.26), el('g', { transform: `rotate(${l.tilt})` }, grp));
    view.set(l, { grp });
  });

  // the HTML layer over the board: the tags, the targets to point at, the prices and the travellers' labels. Each ant's target runs
  // from its head to its name tag under its base and hops with it; the first of each kind takes the keyboard's focus (you, the lookup,
  // the first seed, the first provider and person), the others only the pointer
  const target = (kind, x, top, w, h, focus, word) => {
    const e = document.createElement(focus ? 'button' : 'span');
    e.className = `nd-hit ${kind}`; e.dataset.tip = kind;
    if (focus) { e.type = 'button'; e.setAttribute('aria-describedby', 'nd-tip'); if (!word) e.setAttribute('aria-label', NAME[kind]); }
    else e.setAttribute('aria-hidden', 'true');
    if (word) { const t = document.createElement('span'); t.className = 'nd-tag'; t.textContent = word; e.append(t); e.$word = t; }
    e.style.width = `${w.toFixed(1)}px`; e.style.height = `${h.toFixed(1)}px`;
    e.$x = (x - w / 2).toFixed(1); e.$top = top; e.$a = { x, top, bottom: top + h };
    e.style.transform = `translate(${e.$x}px, ${top.toFixed(1)}px)`;
    ui.append(e);
    return e;
  };
  const tagTop = (n) => n.y + A * 0.18 + 3;
  ants.forEach((n) => {
    const top = n.feet - A, focus = n === you || n === provs[0] || n === users[0];
    view.get(n).tag = target(n.kind, n.x, top, A * 0.8, tagTop(n) - top + TAG, focus, NAME[n.kind]);
  });
  const labLook = target('look', lx, ly, 108, TAG + 12, true, NAME.look);
  lights.forEach((l, i) => { const s = 26; target('dht', l.ax, l.ay - s / 2, s, s, i === 0); });
  // the prices, in the tags' place under each found provider; pointing at one says what it is
  found.forEach((n) => {
    const c = document.createElement('span');
    c.className = 'nd-tag nd-chip'; c.dataset.tip = 'price'; c.setAttribute('aria-hidden', 'true'); c.textContent = usd(n.price);
    c.$top = tagTop(n); c.$a = { x: n.x, top: c.$top, bottom: c.$top + TAG };
    ui.append(c);
    view.get(n).chip = c;
  });
  // the labels riding with your travellers (the same lime glass as the tags): the request and the answer on the first trip, and every
  // payment, both trips, with its value at that provider's price
  const label = (word) => { const e = document.createElement('span'); e.className = 'nd-tag nd-fly'; e.textContent = word; e.setAttribute('aria-hidden', 'true'); ui.append(e); return e; };
  trips.forEach((r) => { r.labels = { req: r.k ? null : label('Request'), res: r.k ? null : label('Answer'), pay: label(paid(r.prov.price)) }; });

  // your travellers: the request a white speech bubble with three dots, the answer the hero's seed (glowing at night), the payment a USDC
  // coin; each casting a soft shadow on the fields below
  const bw = A * 0.42, bh = A * 0.29;
  const bubble = () => {
    const p = el('g', { class: 'nd-bub', opacity: 0 }, gPk), x0 = -bw / 2, x1 = bw / 2, y0 = -bh / 2, y1 = bh / 2, r = bh * 0.42;
    const f = (v) => v.toFixed(1);
    el('path', { d: `M${f(x0 + r)},${f(y0)} H${f(x1 - r)} Q${f(x1)},${f(y0)} ${f(x1)},${f(y0 + r)} V${f(y1 - r)} Q${f(x1)},${f(y1)} ${f(x1 - r)},${f(y1)} H${f(-bw * 0.1)} L${f(-bw * 0.4)},${f(y1 + bh * 0.36)} L${f(-bw * 0.3)},${f(y1)} H${f(x0 + r)} Q${f(x0)},${f(y1)} ${f(x0)},${f(y1 - r)} V${f(y0 + r)} Q${f(x0)},${f(y0)} ${f(x0 + r)},${f(y0)} Z` }, p);
    [-1, 0, 1].forEach((k) => el('circle', { cx: f(k * bw * 0.22), cy: 0, r: f(bh * 0.1) }, p));
    return p;
  };
  const rq = A * 0.36, rw = rq * SEED;
  const answer = () => {
    const p = el('g', { opacity: 0 }, gPk), s = el('g', {}, p);
    seedOf(rq, s);
    p.$spin = s;
    return p;
  };
  const cr = A * 0.15;
  const coin = () => {
    const p = el('g', { class: 'nd-coin', opacity: 0 }, gPk);
    el('circle', { r: cr.toFixed(1) }, p);
    el('image', { href: USDC, x: (-cr + 1.6).toFixed(1), y: (-cr + 1.6).toFixed(1), width: (2 * cr - 3.2).toFixed(1), height: (2 * cr - 3.2).toFixed(1) }, p);
    return p;
  };
  const fall = (r) => el('ellipse', { rx: (r * 0.5).toFixed(1), ry: (r * 0.5 * ISO).toFixed(1), cx: -99, cy: -99, opacity: 0 }, gFall);
  trips.forEach((r) => { r.req = bubble(); r.res = answer(); r.pay = coin(); r.fReq = fall(bw); r.fRes = fall(rq); r.fPay = fall(cr * 2); });
  // the still story's numbers, one per step, each before the tag of what it numbers on the map: the lookup's, the price picked, the
  // request's, the payment's, the next price picked (sections.css .nd-num, in the site's pixel face)
  const nums = B.story ? [1, 2, 3, 4, 5].map((i) => { const e = document.createElement('span'); e.className = 'nd-num'; e.textContent = i; e.setAttribute('aria-hidden', 'true'); ui.append(e); return e; }) : [];

  const hide = (c) => put(c, 'opacity', '0');
  const putDot = (c, p, o) => { put(c, 'cx', p.x.toFixed(1)); put(c, 'cy', p.y.toFixed(1)); put(c, 'opacity', o.toFixed(3)); };
  const putG = (c, p, o) => { put(c, 'transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`); put(c, 'opacity', o.toFixed(3)); };
  // a ring on the ground that opens out and fades, from time te
  const ping = (r, te, t, size) => {
    const e = (t - te) / 800;
    if (e < 0 || e > 1) return hide(r);
    const rx = (10 + size * ease(e)) * u;
    put(r, 'rx', rx.toFixed(1)); put(r, 'ry', (rx * ISO).toFixed(1)); put(r, 'opacity', (0.9 * (1 - e)).toFixed(3));
  };
  // a ring that stays on the ground round a provider found
  const mark = (r, n, o) => { const rx = n.base + 5 * u; put(r, 'rx', rx.toFixed(1)); put(r, 'ry', (rx * ISO).toFixed(1)); put(r, 'opacity', o.toFixed(3)); };
  // a flash of light from te: up fast, then dying away
  const flash = (t, te) => { const e = t - te; return e < 0 ? 0 : e < 160 ? e / 160 : Math.exp(-(e - 160) / 500); };
  // where a traveller is along its curve between ts and ts + dur (null when off it), and how much it shows: in and out at its ends
  const along = (t, ts, dur) => { const s = (t - ts) / dur; return s < 0 || s > 1 ? null : s; };
  // a traveller between ts and ts + dur + hold (null when gone): how far along its curve (s, 1 once landed) and how much it shows,
  // coming in at the start and going out at the end of its wait where it landed
  const travel = (t, ts, dur, hold) => { const d = t - ts; return d < 0 || d > dur + hold ? null : { s: Math.min(1, d / dur), o: Math.min(1, (d / dur) * 7, (dur + hold - d) / 180) }; };
  // a traveller's label, over it (under it when there is no room above), kept inside the panel
  const ride = (e, p, o, above) => {
    if (o <= 0.01) return style(e, 'opacity', '0');
    if (!e.$w || document.fonts.status !== 'loaded') e.$w = e.offsetWidth;
    const w = e.$w, x = Math.min(W - w - 6, Math.max(6, p.x - w / 2));
    let y = p.y - above - 6 - TAG;
    if (y < 4) y = p.y + above + 6;
    style(e, 'transform', `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`); style(e, 'opacity', o.toFixed(3));
  };

  // the reaction under way for ant n at t: yours before the others', then the latest
  const HOP = A * 0.16;
  const doing = (n, t) => {
    let best = null, bd = 0;
    for (const ev of n.ev) {
      const d = ev.wrap ? mod(t - ev.t, LOOP) : t - ev.t;
      if (d < 0 || d >= DUR[ev.kind]) continue;
      if (!best || ev.rank > best.rank || (ev.rank === best.rank && d < bd)) { best = ev; bd = d; }
    }
    return best && { ...best, e: bd };
  };
  // ant n at t: its pose, how high off its base, its squash, its lean (degrees, + forward) and which way it faces
  const act = (n, t) => {
    let pose = 'idle', y = 0, sx = 1, sy = 1, r = 0, face = n.flip;
    const ev = doing(n, t);
    if (ev) {
      const { e, amp: a } = ev;
      if (ev.to) face = (ev.to.ax ?? ev.to.x) < n.x ? -1 : 1;
      if (ev.kind === 'receive') {
        // crouch, a hop up to catch it, a squash as it lands; the hug from the catch on
        const prep = e < 80 ? Math.sin((e / 160) * Math.PI) : 0, air = bump(e, 80, 320), land = bump(e, 400, 200);
        y = -HOP * a * air; sy = 1 - 0.08 * a * prep - 0.13 * a * land + 0.05 * a * air; sx = 1 + 0.06 * a * prep + 0.09 * a * land - 0.03 * a * air;
        if (e >= 200) pose = 'receive';
      } else if (ev.kind === 'send') {
        // wind up (lean back, crouch), toss (forward, up on its toes), back to rest
        const wind = bump(e, 0, 400) * (e < 200 ? 1 : 0), toss = bump(e, 200, 340);
        r = -6 * a * wind + 9 * a * toss; sy = 1 - 0.05 * a * wind + 0.05 * a * toss; sx = 1 + 0.03 * a * wind - 0.02 * a * toss;
        y = -HOP * 0.25 * a * toss;
        if (e >= 100 && e < 540) pose = 'send';
      } else {
        // a bob: a small hop and a squash
        const air = bump(e, 0, 260), land = bump(e, 260, 180);
        y = -HOP * 0.6 * a * air; sy = 1 - 0.1 * a * land + 0.04 * a * air; sx = 1 + 0.07 * a * land;
      }
    }
    return { pose, y, sx, sy, r, face };
  };

  return {
    map: { x: mx, y: my, w: mw, h: mh },
    // the still: the answer on its way back to you, after the pick
    still: T.ask + TRIP.res + TRIP.back * 0.45,
    draw(t, still = false) {
      const out = 1 - clamp01((t - T.fade) / 700);   // the end of the loop: what your story lit lets go
      // the cheapest provider offline from T.off, back as the loop lets go
      const off = still ? 0 : clamp01((t - T.off) / 500) * out;
      // the seeds: floating, rising and sinking slowly, each on its own clock; the lookup's three swell as it reaches them
      lights.forEach((l, k) => {
        const tw = still ? 0 : Math.sin((t / l.per + l.phase) * 2 * Math.PI);
        const fl = still || k >= hops.length ? 0 : flash(t, l.land);
        const s = 1 + 0.6 * fl, y = l.ay + Math.round(tw * 3 * u * 4) / 4;
        const v = view.get(l);
        put(v.grp, 'transform', `translate(${l.ax.toFixed(1)} ${y.toFixed(1)})${s > 1.001 ? ` scale(${s.toFixed(3)})` : ''}`);
      });
      // the lookup: a dotted arc drawn hop by hop behind its leading point, held while the providers ring, then let go
      const lookFade = still ? 0.5 : 1 - clamp01((t - T.lookOff) / 400);
      let lead = null;
      hops.forEach((q, k) => {
        const ts = T.hop0 + k * T.hop, p = still ? 1 : ease(clamp01((t - ts) / T.hopDur));
        const path = hopPaths[k];
        if (p <= 0 || lookFade <= 0) hide(path);
        else { put(path, 'd', pathOf(part(q, Math.max(p, 0.001)))); put(path, 'opacity', lookFade.toFixed(3)); }
        if (!still && p > 0 && p < 1) lead = at(q, p);
      });
      if (lead) putDot(head, lead, 1); else hide(head);
      const lo = still ? 1 : clamp01((t - T.hop0 - 200) / 400) * lookFade;
      style(labLook, 'opacity', lo.toFixed(2)); style(labLook, 'pointerEvents', lo > 0.05 ? '' : 'none');
      // found: each provider rings and keeps a lime ring at its feet; its price pops in under it, the cheapest picked (lime), and when
      // it goes offline its chip says so and the next is picked
      found.forEach((n, k) => {
        const v = view.get(n), te = T.found + k * T.ring;
        const gone = n === first ? off : 0;
        mark(v.mark, n, (still ? 1 : clamp01((t - te) / 300) * out) * (1 - gone));
        if (!still && t < te + 800) ping(v.ping, te, t, 26); else hide(v.ping);
        const pop = still ? 1 : clamp01((t - T.chip - k * T.chipGap) / 260), o = pop * out;
        const c = v.chip, offline = gone > 0.5;
        const picked = !offline && (n === first ? still || t >= T.pick : n === second && !still && t >= T.repick);
        c.classList.toggle('pick', picked); c.classList.toggle('off', offline);
        const word = offline ? 'Offline' : usd(n.price);
        if (c.textContent !== word) c.textContent = word;
        c.dataset.tip = offline ? 'off' : 'price';
        v.chipO = o; v.chipS = 0.7 + 0.3 * ease(pop);
        style(c, 'opacity', o.toFixed(3)); style(c, 'pointerEvents', o > 0.3 ? '' : 'none');
        v.tag.dataset.tip = offline ? 'off' : 'prov';
        put(v.grp, 'filter', gone > 0 ? 'url(#nd-grey)' : 'none');
        if (n === first) { put(grey, 'values', (1 - gone).toFixed(3)); put(v.grp, 'opacity', (1 - 0.5 * gone).toFixed(3)); }
      });
      // your links: to the cheapest once picked, faded as it goes offline; then to the next
      const shown = [
        still ? 1 : ease(clamp01((t - T.link) / T.linkDur)),
        still ? 0 : ease(clamp01((t - T.relink) / T.linkDur)),
      ];
      const fades = [still ? 1 : out * (1 - clamp01((t - T.off) / 500)), out];
      linkPaths.forEach((path, k) => {
        const p = shown[k], o = p > 0 ? fades[k] : 0;
        put(path, 'stroke-dasharray', `${p.toFixed(4)} 1`); put(path, 'opacity', o.toFixed(3));
        put(linkHits[k], 'visibility', p > 0.5 && o > 0.3 ? 'visible' : 'hidden');
      });
      // the trips: the request out, the answer back, the coin out; the line glowing where each one is, its shadow on the fields
      trips.forEach((r) => {
        const { D, q } = r;
        let lit = null, lo2 = 0;
        // it lands beside the ant it goes to, not on it: drawn over the pieces, it ends half its width out from the line's end
        const fly = (obj, f, m, back, size, lab, half) => {
          if (m === null) { hide(obj); hide(f); if (lab) ride(lab, { x: 0, y: 0 }, 0, 0); return; }
          const e = back ? 1 - ease(m.s) : ease(m.s), p = at(q, e), o = still ? 1 : m.o, to = back ? you : r.prov, end = back ? q.a : q.b;
          p.x += Math.sign(end.x - to.x) * half * ease(m.s) ** 3;
          putG(obj, p, o); putDot(f, ground(q, e), o * 0.8);
          if (obj.$spin) put(obj.$spin, 'transform', `rotate(${(still ? -30 : (1 - e) * 300).toFixed(0)})`);
          if (lab) ride(lab, p, o, size);
          if (m.s < 1) { lit = e; lo2 = o; }
        };
        const s1 = still ? null : travel(t, r.t, D.fly, D.hold);
        const s2 = still ? (r.k ? null : { s: 0.45, o: 1 }) : travel(t, r.t + D.res, D.back, D.hold);
        const s3 = still ? null : travel(t, r.t + D.pay, D.payFly, D.hold);
        fly(r.req, r.fReq, s1, false, bh * 0.75, r.labels.req, bw * 0.55);
        fly(r.res, r.fRes, s2, true, rq * 0.6, r.labels.res, rw * 0.8);
        fly(r.pay, r.fPay, s3, false, cr, r.labels.pay, cr * 1.1);
        const lp = litPaths[r.k];
        if (lit === null) hide(lp); else { put(lp, 'stroke-dashoffset', (0.06 - lit).toFixed(4)); put(lp, 'opacity', (lo2 * 0.9).toFixed(3)); }
      });
      // the others, quiet: a faint link drawn in, held, let go
      const to = still ? B.stillOthers : t;
      sessions.forEach((o) => {
        const lt = mod(to - o.start, LOOP);
        if (lt >= o.dur) return hide(o.path);
        const p = still ? 1 : ease(clamp01(lt / O.draw)), f = still ? 1 : clamp01((o.dur - lt) / O.end);
        put(o.path, 'stroke-dasharray', `${p.toFixed(4)} 1`); put(o.path, 'opacity', f.toFixed(3));
      });
      // the ants: what each is doing, breathing under it all (at rest in the still)
      ants.forEach((n) => {
        const v = view.get(n), a = still ? { pose: 'idle', y: 0, sx: 1, sy: 1, r: 0, face: n.flip } : act(n, t);
        const br = still ? 0 : Math.round(Math.sin((t / BREATH + n.phase) * 2 * Math.PI) * 6) / 6;   // in steps, so most frames write nothing
        const sy = a.sy * (1 + 0.014 * br), sx = a.sx * (1 - 0.006 * br);
        put(v.body, 'transform', `translate(${n.x.toFixed(1)} ${(n.feet + a.y).toFixed(1)}) rotate(${(a.r * a.face).toFixed(1)}) scale(${(sx * a.face).toFixed(3)} ${sy.toFixed(3)})`);
        const pose = v.poses[a.pose] ? a.pose : 'idle';
        for (const k in v.poses) put(v.poses[k], 'visibility', k === pose ? 'visible' : 'hidden');
        // its shadow tightens and fades as it leaves the ground
        const lift = clamp01(-a.y / HOP), rx = v.shr * (1 - 0.25 * lift);
        put(v.sh, 'rx', rx.toFixed(1)); put(v.sh, 'ry', (rx * ISO).toFixed(1)); put(v.sh, 'opacity', (1 - 0.35 * lift).toFixed(2));
        // its tag and its price hop with it; a price takes its tag's place while it shows
        style(v.tag, 'transform', `translate(${v.tag.$x}px, ${(v.tag.$top + a.y).toFixed(1)}px)`);
        if (v.chip) {
          style(v.chip, 'transform', `translate(${n.x.toFixed(1)}px, ${(v.chip.$top + a.y).toFixed(1)}px) translateX(-50%) scale(${v.chipS.toFixed(3)})`);
          if (v.tag.$word) style(v.tag.$word, 'opacity', (1 - v.chipO).toFixed(3));
        }
      });
    },
    // the still story, after step k (1 to 5), or with k 0 all of it: steps 1 to 4 at rest, each numbered. The step just taken in full,
    // those before it faint (FAINT), those after not there yet; when you move on (5), what went to the provider that went down is left
    // behind (LEFT). Every piece at rest, nothing else shows
    step(k) {
      const all = !k, now = all ? 4 : k, moved = now >= 5;
      const lit = (i) => (i > now ? 0 : moved && (i === 3 || i === 4) ? LEFT : all || i === now ? 1 : FAINT);
      ants.forEach((n) => {
        const v = view.get(n);
        put(v.body, 'transform', `translate(${n.x.toFixed(1)} ${n.feet.toFixed(1)}) scale(${n.flip} 1)`);
        for (const q in v.poses) put(v.poses[q], 'visibility', q === 'idle' ? 'visible' : 'hidden');
        style(v.tag, 'transform', `translate(${v.tag.$x}px, ${v.tag.$top.toFixed(1)}px)`);
      });
      // 1 look up: the dotted path through the three seeds, its tag over it
      const lo = lit(1);
      hops.forEach((q, i) => { put(hopPaths[i], 'd', pathOf(q)); put(hopPaths[i], 'opacity', lo.toFixed(2)); });
      hide(head);
      style(labLook, 'opacity', lo.toFixed(2)); style(labLook, 'pointerEvents', '');
      // 2 pick: the prices in the tags' place, each after the provider's name (grey), the cheapest filled; 5 move on: it says Offline,
      // greyed, and the next is filled. Each chip kept inside the board
      const chipX = (n) => { const w = view.get(n).chip.offsetWidth; return Math.min(W - w / 2 - 6, Math.max(w / 2 + 6, n.x)); };
      found.forEach((n) => {
        const v = view.get(n), c = v.chip, off = moved && n === first, pick = (n === first && !off) || (n === second && moved);
        c.classList.toggle('pick', pick); c.classList.toggle('off', off);
        const word = off ? 'Offline' : usd(n.price);
        if (c.dataset.word !== word) {
          const who = document.createElement('span'); who.className = 'nd-who'; who.textContent = NAME.prov;
          c.replaceChildren(who, word); c.dataset.word = word;
        }
        c.dataset.tip = off ? 'off' : 'price'; v.tag.dataset.tip = off ? 'off' : 'prov';
        const o = now < 2 ? 0 : off || (moved && n === second) ? 1 : lit(2);
        style(c, 'opacity', o.toFixed(2)); style(c, 'pointerEvents', o ? '' : 'none');
        style(c, 'transform', `translate(${chipX(n).toFixed(1)}px, ${c.$top.toFixed(1)}px) translateX(-50%)`);
        if (v.tag.$word) style(v.tag.$word, 'opacity', o ? '0' : '1');
        put(v.grp, 'filter', off ? 'url(#nd-grey)' : 'none'); put(v.grp, 'opacity', off ? '0.5' : '1');
        if (v.mark) hide(v.mark); if (v.ping) hide(v.ping);
      });
      put(grey, 'values', '0');
      // 3 talk directly: your link to it, the request on it; 5: your link to the next. In all of it, the next one at rest too: a
      // thinner dashed link, lighter than the live one, ready if the first goes down
      const ln = [lit(3), moved ? 1 : all ? 0.7 : 0];
      linkPaths.forEach((path, i) => {
        const standby = all && i === 1, L = path.getTotalLength() || 1;
        put(path, 'stroke-dasharray', standby ? `${(9 / L).toFixed(4)} ${(9 / L).toFixed(4)}` : '1 1');
        style(path, 'strokeWidth', standby ? '3px' : '');
        put(path, 'opacity', ln[i].toFixed(2)); put(linkHits[i], 'visibility', ln[i] > 0.3 ? 'visible' : 'hidden'); hide(litPaths[i]);
      });
      // the travellers on it, at rest: the request half way, the coin near the provider, each with its tag over it
      const q = links[0];
      const sit = (obj, f, lab, s, o, above) => {
        if (!o) { hide(obj); hide(f); if (lab) style(lab, 'opacity', '0'); return null; }
        const p = at(q, s);
        putG(obj, p, o); putDot(f, ground(q, s), o * 0.8);
        if (!lab) return { x: p.x - bw / 2, y: p.y - bh / 2 };
        ride(lab, p, o, above);
        const w = lab.$w, x = Math.min(W - w - 6, Math.max(6, p.x - w / 2));
        let y = p.y - above - 6 - TAG;
        if (y < 4) y = p.y + above + 6;
        return { x, y };
      };
      const [r, r2] = trips;
      // the request has no tag of its own: its number stands just before it
      const atReq = sit(r.req, r.fReq, null, 0.5, lit(3), bh * 0.75), atPay = sit(r.pay, r.fPay, r.labels.pay, 0.84, lit(4), cr);
      hide(r.res); hide(r.fRes); style(r.labels.res, 'opacity', '0'); style(r.labels.req, 'opacity', '0');
      [r2.req, r2.res, r2.pay, r2.fReq, r2.fRes, r2.fPay].forEach(hide);
      Object.values(r2.labels).forEach((e) => e && style(e, 'opacity', '0'));
      // the numbers, each just before its tag, as faint as what it numbers
      const D = tall ? 17 : 19, gap = 4;
      const num = (i, right, mid) => {
        const e = nums[i - 1], o = i === 5 ? (moved || all ? 1 : 0) : lit(i);
        style(e, 'opacity', o.toFixed(2));
        if (o) style(e, 'transform', `translate(${(right - gap - D).toFixed(1)}px, ${(mid - D / 2).toFixed(1)}px)`);
      };
      const chipAt = (n) => { const c = view.get(n).chip; return [chipX(n) - c.offsetWidth / 2, c.$top + c.offsetHeight / 2]; };
      num(1, lx - labLook.$word.offsetWidth / 2, ly + (TAG + 12) / 2);
      num(2, ...chipAt(first));
      if (atReq) num(3, atReq.x, atReq.y + bh / 2); else num(3, 0, 0);
      if (atPay) num(4, atPay.x, atPay.y + r.labels.pay.offsetHeight / 2); else num(4, 0, 0);
      // 5: by the next price once you move on; in all of it, over the standby link's middle
      if (all) { const p = at(links[1], 0.5); num(5, p.x + D / 2 + gap, p.y - D / 2 - 6); } else num(5, ...chipAt(second));
    },
  };
}
