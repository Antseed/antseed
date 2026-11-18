// Antseed homepage below the hero: micro-animations inside the illustration cards
// 1. two watchers: .mi-in once a panel comes into view (its one-off play), .mi-on while it is on screen (its loop; micro.css pauses it otherwise)
// 2. each card's play, in page order: hooks added here as .mi-… classes and small inserted elements, the motion itself in micro.css
// With reduced motion none of it runs: no .mi on the page, so everything stays in its end state and nothing loops.
await import('./sections.js').catch(() => {});   // the module index.html imports too: wait for it, so its hooks (.typing, --pct, counters) are in place
const root = document.querySelector('.s-page');
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (root && !still) start();

function start() {
  const $ = (s, el = root) => el.querySelector(s), $$ = (s, el = root) => [...el.querySelectorAll(s)];
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const panel = (sel, within = root) => { const el = $(sel, within); return el && el.closest('.wash'); };
  root.classList.add('mi');

  // ── 1. watchers ────────────────────────────────────────────────────────
  // once a third of it is on screen: fn first (so it can measure), then .mi-in starts the CSS
  function once(els, fn, threshold = 0.35) {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target); if (fn) fn(e.target); e.target.classList.add('mi-in');
    }), { threshold });
    els.filter(Boolean).forEach((el) => io.observe(el));
  }
  // while any of it is on screen: .mi-on, and the timer if it has one (stopped, not just paused, off screen)
  const timers = new Map();
  const onScreen = new IntersectionObserver((entries) => entries.forEach((e) => {
    e.target.classList.toggle('mi-on', e.isIntersecting);
    const t = timers.get(e.target); if (t) (e.isIntersecting ? t.start() : t.stop());
  }));
  function loop(el, timer) { if (!el) return; el.classList.add('mi-loop'); if (timer) timers.set(el, timer); onScreen.observe(el); }
  // a setTimeout chain, about every ms (±20%), that a loop starts and stops
  const every = (ms, fn) => {
    let t = 0;
    const tick = () => { fn(); t = setTimeout(tick, ms * (0.8 + Math.random() * 0.4)); };
    return { start() { clearTimeout(t); t = setTimeout(tick, ms * 0.6); }, stop() { clearTimeout(t); t = 0; } };
  };
  // a figure counting up once, eased out, and a rAF that ends with it
  function count(el, to, dur, show) {
    const t0 = performance.now();
    const tick = (now) => { const k = Math.min(1, (now - t0) / dur); el.textContent = show(to * (1 - (1 - k) ** 3)); if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  // a class for one CSS play, taken off when it ends so it can play again
  const replay = (el, cls) => { if (!el || el.classList.contains(cls)) return; el.classList.add(cls); el.addEventListener('animationend', () => el.classList.remove(cls), { once: true }); };
  // index each element as --mi-i, for staggers in CSS
  const stagger = (els) => els.forEach((el, k) => el.style.setProperty('--mi-i', k));

  // ── 2. the cards ───────────────────────────────────────────────────────
  // Gateway: the cursor blinks only while the terminal is on screen
  loop(panel('.term'));

  // Antseed Desktop: the two windows rise in
  const vpn = $('.vpn');
  if (vpn) once([vpn.closest('.wash')]);

  // For the people: Hermes' provider menu drops and the pointer picks Antseed; the request's fields come in one after another, a light
  // runs over "encrypted · TEE"; the budgets fill, then the agent's model menu opens
  const agents = panel('.v6-agents'), heavy = panel('.px.warn'), privacy = panel('.v6-privacy'), teams = panel('.v6-teams');
  once([agents]);
  if (heavy) { heavy.classList.add('mi-heavy'); const px = $('.px:not(.warn)', heavy); if (px) px.insertAdjacentHTML('beforeend', '<i class="mi-next"></i>'); once([heavy]); loop(heavy); }
  if (privacy) {
    const dd = $$('.v6-privacy-fields dd', privacy), enc = dd[dd.length - 1], txt = enc && [...enc.childNodes].find((n) => n.nodeType === 3 && n.data.trim());
    stagger(dd);
    if (txt) { const sweep = Object.assign(document.createElement('span'), { className: 'mi-sweep', textContent: txt.data.trim() }); txt.replaceWith(sweep); }
    once([privacy]); loop(privacy);
  }
  if (teams) { stagger($$('.v6-teams-use b', teams)); once([teams]); }

  // Providers: the new price types in behind its caret; a request comes in over the one served, and every few seconds Accept is pressed
  // and the next one arrives; Colony's rows land, its last payment flashing now and then
  const gpu = panel('.v6-gpu'), cap = panel('.v6-cap'), colony = panel('.v6-colony');
  if (gpu) {
    const price = $('.v6c-price.on b', gpu), to = price && price.textContent;
    if (to && to.length > 3) {
      price.textContent = to.slice(0, 3);
      once([gpu], async () => { await wait(700); for (let n = 4; n <= to.length; n++) { price.textContent = to.slice(0, n); await wait(180); } });
    } else once([gpu]);
    loop(gpu);
  }
  if (cap) {
    const win = $('.v6-cap-win', cap), accept = $('.v6-cap-acts .s-btn', cap);
    once([cap]);
    loop(cap, every(5500, async () => { replay(accept, 'mi-tap'); await wait(280); replay(win, 'mi-again'); }));
  }
  if (colony) { stagger($$('.v6-colony-row', colony)); once([colony]); loop(colony); }
  // the providers' two paths come in one after another, left to right: those that come into view together each a
  // beat after the one before; on a phone, stacked, each as it comes
  const provs = $$('.s-prov .s-paths > article');
  if (provs.length) {
    const io = new IntersectionObserver((entries) => {
      let k = 0;
      for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); e.target.style.setProperty('--mi-i', k++); e.target.classList.add('mi-in'); }
    }, { threshold: 0.2 });
    provs.forEach((el) => { el.classList.add('mi-card'); io.observe(el); });
  }

  // Network: its diagram plays from net.js; here only the three points under it
  const points = $('.s-points');
  if (points) { const ps = $$('p', points); stagger(ps); ps.forEach((p) => { p.innerHTML = `<span class="mi-t">${p.innerHTML}</span>`; }); once([points]); }

  // Privacy and trust: the four points share one place (sections.js chooses one): the chosen screen plays as the section comes into
  // view (privacy-v4.css: the thread runs, the bars grow, the enclave lights, the rows land), then again each time it is chosen
  const priv = $('.s-priv');
  if (priv) {
    const play = (w) => {
      if (!w) return;
      w.classList.add('mi-reset'); w.classList.remove('mi-in');
      void w.offsetWidth; w.classList.remove('mi-reset');
      requestAnimationFrame(() => requestAnimationFrame(() => w.classList.add('mi-in')));
    };
    const stage = $('.s-pv-stage', priv);
    if (stage) {
      let seen = false;
      once([stage], () => { seen = true; play($('.s-pv-panel.on', stage)); });
      priv.addEventListener('pv:select', (e) => { if (seen) play(e.detail.panel); });
    }
  }
}
