// The Gateway's console (hero/parts/gw-console.html): its chapters advance on their own while it is on screen, each with a lime line
// filling under its name; a click or the arrow keys pick one and hold the loop a moment. With Antseed's video in .gwc-video the window
// plays the film instead and the chapters seek it (data-t, in seconds), as in Amos's site. With reduced motion: no loop, no fills.
const STEP = 5200, HOLD = 12000;
for (const root of document.querySelectorAll('[data-gwc]')) start(root);

function start(root) {
  const tabs = [...root.querySelectorAll('[role="tab"]')], panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));
  const video = root.querySelector('.gwc-video video'), still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let cur = 0, t0 = 0, raf = 0, seen = false, held = 0;
  // each screen's rows, numbered for their stagger (gw-console.css)
  for (const p of panels) p.querySelectorAll('tbody tr, .gwc-a, .gwc-by, .gwc-rules, .gwc-tiles > div, .gwc-chart i').forEach((el, k, all) => {
    const within = el.parentElement ? [...el.parentElement.children].indexOf(el) : k; el.style.setProperty('--k', within); });
  if (!still) root.classList.add('mo');

  function show(i, how) {
    cur = i; t0 = performance.now();
    tabs.forEach((t, k) => { const on = k === i; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; t.style.setProperty('--p', on && still ? 1 : 0); });
    if (how === 'key') tabs[i].focus();
    if (video) { video.currentTime = Number(tabs[i].dataset.t) || 0; video.play().catch(() => {}); return; }
    panels.forEach((p, k) => { const on = k === i; p.hidden = !on; p.classList.remove('in'); });
    requestAnimationFrame(() => requestAnimationFrame(() => panels[i].classList.add('in')));
  }

  // the film: its chapter lit from where it plays, the line filling to the next chapter's start
  if (video) {
    root.classList.add('film');
    const times = tabs.map((t) => Number(t.dataset.t) || 0);
    video.addEventListener('timeupdate', () => {
      let k = 0; times.forEach((t, i) => { if (video.currentTime >= t - 0.05) k = i; });
      const end = times[k + 1] ?? (video.duration || times[k] + 1);
      tabs.forEach((t, i) => { t.setAttribute('aria-selected', String(i === k)); t.tabIndex = i === k ? 0 : -1;
        t.style.setProperty('--p', i === k ? Math.min(1, (video.currentTime - times[k]) / (end - times[k])) : 0); });
    });
    if (still) video.controls = true;
  }

  // the loop: the chosen chapter's line fills over STEP, then the next; paused off screen, in a hidden tab, and for HOLD after a choice
  const tick = (now) => {
    raf = 0;
    if (!seen || document.hidden || video) return;
    if (now < held) { tabs[cur].style.setProperty('--p', 1); raf = requestAnimationFrame(tick); return; }
    const k = (now - t0) / STEP;
    if (k >= 1) show((cur + 1) % tabs.length);
    else tabs[cur].style.setProperty('--p', k);
    raf = requestAnimationFrame(tick);
  };
  const run = () => { if (!raf && !still) raf = requestAnimationFrame(tick); };

  tabs.forEach((t, i) => {
    t.addEventListener('click', () => { held = performance.now() + HOLD; show(i); });
    t.addEventListener('keydown', (e) => {
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault(); held = performance.now() + HOLD; show((to + tabs.length) % tabs.length, 'key');
    });
  });
  new IntersectionObserver(([e]) => {
    seen = e.isIntersecting;
    if (video) { if (seen && !still) video.play().catch(() => {}); else video.pause(); return; }
    if (seen) { t0 = performance.now() - (Number(tabs[cur].style.getPropertyValue('--p')) || 0) * STEP; panels[cur].classList.add('in'); run(); }
  }, { threshold: 0.4 }).observe(root);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && seen) { t0 = performance.now(); run(); } else if (video) video.pause(); });
  tabs.forEach((t, k) => { t.setAttribute('aria-selected', String(k === 0)); t.tabIndex = k === 0 ? 0 : -1; if (still && !k) t.style.setProperty('--p', 1); });
  panels.forEach((p, k) => { p.hidden = k !== 0; });
  if (video) video.currentTime = 0;
}
