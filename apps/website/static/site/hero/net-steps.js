// The network in five steps (amos-09-r2, amos-09-r3), the default style of the network's board (.s-net-panel, data-net-style="steps"):
// five glass cards on the map (.ns > li, their copy in sections.html), each joined to the next by a line (a quiet track, the card's
// ::after, and the lime drawn over it, its ::before, sections.css). While on screen it plays them in turn: card 1 lights up, its line
// draws to card 2, card 2 lights up, and so on to 5; it holds on the whole picture, fades it all back to rest and starts again. At rest
// nothing goes: every card keeps its glass and its content dimmed, every line its track (the steps not reached stay
// visible). A card's light is its --in, a line's length its --p and its light its --pl, all from 0 to 1, so the CSS alone shows the
// whole picture: before it is in view, with reduced motion, without this script. The time stands still off screen and while the
// panel's painting is still arriving (card-unveil.js), so the story starts once the board is there: on the whole picture a moment,
// then from rest. panel.netStepsAt(ms) stops it and shows that moment of the loop (for captures; LOOP is its length).
// As a card lights up it takes .go, and its icon makes its own small move (sections.css; the same move plays on hover); .go comes off
// as the picture fades back to rest, so the move plays again next time round, and it is only given on the way, never all at once when
// the story starts. On a phone, one card at a time (amos-09-r7). The lime bar along the
// board's edge is gone.

const LEAD = 300;     // ms at rest before card 1
const CARD = 500;     // a card lighting up
const LINE = 700;     // its line drawing to the next; a step is CARD + LINE
const HOLD = 3000;    // on the whole picture
const OUT = 700;      // the fade back to rest (cards dimmed, lines down to their track)
const FIRST = 1200;   // the first time, how long the whole picture shows before it fades to rest
const N = 5;
const FULL = LEAD + (N - 1) * (CARD + LINE) + CARD;   // card 5 is in
export const LOOP = FULL + HOLD + OUT;
// on a phone the cards are one at a time, each the screen's width, side by side in a strip (sections.css): the story slides the strip to
// each card as it lights up and holds it long enough to read, then back to the first. A swipe takes over: the story waits on the card
// swiped to (lit, with all before it), and goes on from there once the strip has been left alone a while
const phone = matchMedia('(max-width: 760px)');
const PHONE = { LINE: 2600, HOLD: 2400 };
const IDLE = 6000;    // ms after a swipe before the story goes on
const timing = () => {
  const line = phone.matches ? PHONE.LINE : LINE, hold = phone.matches ? PHONE.HOLD : HOLD;
  const full = LEAD + (N - 1) * (CARD + line) + CARD;
  return { line, hold, full, loop: full + hold + OUT };
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const fadeIn = (t) => 1 - (1 - t) ** 3;
const glide = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function mount(panel, { still = false } = {}) {
  const list = panel.querySelector('.ns'), cards = [...panel.querySelectorAll('.ns > li')];
  if (!cards.length || still) return;
  // a write only when the value changes, so a picture at rest costs nothing
  const set = (el, k, v) => { const s = v.toFixed(3); if (el.style.getPropertyValue(k) !== s) el.style.setProperty(k, s); };
  let T = timing(), was = -1, shownCard = -1;   // the moment shown last, so a card's move starts only as the story passes its start
  const at = (i) => LEAD + i * (CARD + T.line);
  // the strip (a phone): to card i, by the story; a card's place is its offset in the strip
  const slide = (i) => { if (!phone.matches || i === shownCard) return; shownCard = i; list.scrollTo({ left: cards[i].offsetLeft - cards[0].offsetLeft, behavior: 'smooth' }); };
  const show = (t) => {
    const out = 1 - fadeIn(clamp01((t - T.full - T.hold) / OUT));
    let lit = 0;
    cards.forEach((c, i) => {
      if (t < at(i) || t >= T.full + T.hold) c.classList.remove('go');
      else if (was >= 0 && was < at(i)) c.classList.add('go');
      if (t >= at(i)) lit = i;
      set(c, '--in', fadeIn(clamp01((t - at(i)) / CARD)) * out);
      if (i < N - 1) { set(c, '--p', glide(clamp01((t - at(i) - CARD) / T.line))); set(c, '--pl', out); }
    });
    if (!user) slide(t >= T.full + T.hold ? 0 : lit);
    was = t;
  };

  // the first time: the whole picture a moment, then from rest; on a phone, from rest on card 1 (one card shows, not the picture)
  let t = phone.matches ? 0 : T.full + T.hold - FIRST, seen = false, raf = 0, last = 0, held = false, user = 0;
  const tick = (now) => {
    raf = 0;
    if (!seen || document.hidden || held) return;
    if (user && now - user > IDLE) user = 0;
    if (!panel.dataset.unveil && !user) { t = (t + Math.min(now - last, 50)) % T.loop; show(t); }
    last = now;
    raf = requestAnimationFrame(tick);
  };
  const play = () => { if (!raf && seen && !held && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(tick); } };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  new IntersectionObserver(([e]) => { seen = e.isIntersecting; if (seen) play(); else stop(); }, { threshold: 0.3 }).observe(panel);
  document.addEventListener('visibilitychange', play);
  phone.addEventListener('change', () => { const k = t / T.loop; T = timing(); t = k * T.loop; shownCard = -1; list.scrollLeft = 0; });
  // a swipe: the story waits; once the strip settles, the card in view and those before it are lit
  const touch = () => { if (phone.matches) user = performance.now(); };
  list.addEventListener('pointerdown', touch, { passive: true });
  list.addEventListener('touchstart', touch, { passive: true });
  list.addEventListener('wheel', touch, { passive: true });
  let settle = 0;
  list.addEventListener('scroll', () => {
    if (!user) return;
    user = performance.now();
    clearTimeout(settle);
    settle = setTimeout(() => {
      const w = cards[1].offsetLeft - cards[0].offsetLeft, i = Math.max(0, Math.min(N - 1, Math.round(list.scrollLeft / w)));
      shownCard = i; t = at(i) + CARD; show(t);
    }, 120);
  }, { passive: true });
  panel.netStepsAt = (ms) => { held = true; stop(); show(((ms % T.loop) + T.loop) % T.loop); };
}
