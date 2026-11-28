// antseed.js: only what antseed.css cannot do. Load it in <head> without defer: the theme is set before the first paint.
// 1 theme (system, light, dark; kept in localStorage 'antseed.theme', as the live site) · 2 nav switch and footer switch ·
// 3 Providers menu · 4 phone menu · 5 every section a multiple of 8px tall (and the hero's rounding where round() is missing) ·
// 6 the closing band's card a multiple of 16px tall. The FAQ needs no script (<details name="faq">).
(() => {
  const KEY = 'antseed.theme', MODES = ['system', 'light', 'dark'], root = document.documentElement, mq = matchMedia('(prefers-color-scheme: dark)');
  let mode = 'system';
  try { const v = localStorage.getItem(KEY); if (MODES.includes(v)) mode = v; } catch {}
  const apply = (event) => {
    const t = mode === 'system' ? (mq.matches ? 'dark' : 'light') : mode;
    root.dataset.theme = t; root.style.colorScheme = t;
    if (event) document.dispatchEvent(new Event('themechange'));
  };
  apply(false);
  window.antseedTheme = {
    get: () => mode,
    set(m) {
      mode = MODES.includes(m) ? m : 'system';
      try { localStorage.setItem(KEY, mode); } catch {}
      if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(() => apply(true)); else apply(true);
    },
  };
  mq.addEventListener('change', () => { if (mode === 'system') apply(true); });

  document.addEventListener('DOMContentLoaded', () => {
    // 2. the nav's day/night slider flips what is showing; the footer's three buttons pick system, light or dark
    const sw = document.querySelector('.theme-btn');
    const showSw = () => sw && sw.setAttribute('aria-checked', String(root.dataset.theme === 'dark'));
    if (sw) sw.addEventListener('click', () => window.antseedTheme.set(root.dataset.theme === 'dark' ? 'light' : 'dark'));
    const three = document.querySelector('.s-foot .theme');
    const showThree = () => three && three.querySelectorAll('button[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    if (three) three.addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) window.antseedTheme.set(b.dataset.mode); });
    document.addEventListener('themechange', () => { showSw(); showThree(); });
    showSw(); showThree();

    // 3. the Providers menu: opens on hover with a mouse, on click, on ArrowDown; closes on Escape, a click outside, focus leaving
    const nav = document.querySelector('.s-nav'), dd = nav && nav.querySelector('.dd');
    if (dd) {
      const t = dd.querySelector('.dd-t'), m = dd.querySelector('.dd-m');
      const set = (on) => { dd.classList.toggle('open', on); t.setAttribute('aria-expanded', String(on)); m.hidden = !on; };
      let over = false;
      t.addEventListener('click', () => set(over || m.hidden));
      t.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); set(true); m.querySelector('a').focus(); } });
      dd.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { over = true; set(true); } });
      dd.addEventListener('pointerleave', () => { over = false; if (!dd.contains(document.activeElement)) set(false); });
      dd.addEventListener('focusout', () => setTimeout(() => { if (!dd.contains(document.activeElement)) set(false); }, 0));
      document.addEventListener('click', (e) => { if (!dd.contains(e.target)) set(false); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.hidden) { set(false); t.focus(); } });
    }

    // 4. the phone menu (under 1080px): a sheet under the nav with the nav's own links, the Providers pages indented under it
    const btn = nav && nav.querySelector('.menu-btn');
    if (btn) {
      const menu = Object.assign(document.createElement('div'), { id: 'site-menu', className: 'site-menu', hidden: true });
      const links = document.createElement('div'); links.className = 'sm-links';
      for (const el of nav.querySelectorAll('.links > a, .links > .dd, .nav-txt a')) {
        if (el.classList.contains('dd')) {
          const head = Object.assign(document.createElement('a'), { textContent: el.querySelector('.dd-t').textContent.trim() });
          const first = el.querySelector('.dd-m a'); if (first) head.href = first.getAttribute('href');
          const sub = document.createElement('div'); sub.className = 'sm-sub';
          el.querySelectorAll('.dd-m a').forEach((a) => sub.append(a.cloneNode(true)));
          links.append(head, sub);
        } else links.append(el.cloneNode(true));
      }
      const acts = document.createElement('div'); acts.className = 'sm-acts';
      nav.querySelectorAll('.acts > .cta').forEach((c) => { const k = c.cloneNode(true); k.removeAttribute('id'); acts.append(k); });
      menu.append(links, acts); document.body.append(menu);
      // while the sheet is open, the page it covers is inert (no focus, hidden from screen readers) and Tab cycles through the sheet's
      // links and the close button; closing hands focus back to the button if it was in the sheet
      const covered = [];
      const cover = (on) => {
        if (on) { for (const el of document.body.children) if (el !== menu && !el.contains(nav) && !el.inert) { el.inert = true; covered.push(el); } }
        else covered.splice(0).forEach((el) => { el.inert = false; });
      };
      const stops = () => [...menu.querySelectorAll('a[href], button'), btn].filter((el) => el.getClientRects().length);
      const open = (on) => {
        if (on) { menu.style.setProperty('--sm-top', `${Math.max(0, nav.getBoundingClientRect().bottom)}px`);
          menu.style.setProperty('--sm-x', `${Math.max(16, nav.querySelector('a').getBoundingClientRect().left)}px`); }
        const inside = menu.contains(document.activeElement);
        menu.hidden = !on; btn.setAttribute('aria-expanded', String(on)); btn.setAttribute('aria-label', on ? 'Close menu' : 'Menu');
        root.classList.toggle('menu-open', on);
        cover(on);
        if (on) menu.querySelector('a[href]')?.focus();   // keyboard users land in the sheet, not behind it
        else if (inside) btn.focus();
      };
      btn.addEventListener('click', () => open(menu.hidden));
      menu.addEventListener('click', (e) => { if (e.target.closest('a')) open(false); });
      document.addEventListener('keydown', (e) => {
        if (menu.hidden) return;
        if (e.key === 'Escape') { open(false); btn.focus(); return; }
        if (e.key !== 'Tab') return;
        const list = stops(), i = list.indexOf(document.activeElement);
        e.preventDefault();
        list[i < 0 ? 0 : (i + (e.shiftKey ? -1 : 1) + list.length) % list.length]?.focus();
      });
      matchMedia('(min-width: 1080px)').addEventListener('change', (e) => { if (e.matches) open(false); });
    }

    // 5. every section a multiple of 8px tall, so each top and its dotted line land on a row of the margin's dots.
    //    The closing band and the footer are left as they are (as on the live site).
    //    Every pass measures from scratch (all min-heights cleared first), so a section shrinks as well as grows. A section held up by its
    //    min-height doesn't change size when its content gets shorter, so content changes are watched too: an FAQ answer opened or closed,
    //    text or elements added or removed, a picture swapped or loaded, the fonts arriving. Passes run on a frame, never inside an observer.
    const secs = [...document.querySelectorAll('.s-page > .s-sec:not(.cta-band, .s-foot)')];
    const snapAll = () => {
      secs.forEach((sec) => { sec.style.minHeight = ''; });
      const heights = secs.map((sec) => sec.getBoundingClientRect().height);
      secs.forEach((sec, i) => { const h = heights[i], to = Math.ceil(h / 8 - 0.02) * 8; if (to > h) sec.style.minHeight = `${to}px`; });
    };
    let snapQueued = false;
    const resnap = () => { if (!snapQueued) { snapQueued = true; requestAnimationFrame(() => { snapQueued = false; snapAll(); }); } };
    if (secs.length) {
      snapAll();
      const ro = new ResizeObserver(resnap);
      secs.forEach((s) => ro.observe(s));
      new MutationObserver(resnap).observe(secs[0].parentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open', 'hidden', 'src', 'srcset'] });
      document.addEventListener('load', resnap, true);
      document.fonts.ready.then(resnap);
      // An FAQ answer folds away over its ::details-content transition, which fires no transition events and leaves the section's size
      // alone, so after a toggle (and during any size transition inside a section) every frame is re-measured until the longest transition
      // on that element is over: the section follows the answer down. Capped at 2s.
      const page = secs[0].parentElement, sizing = /height|block-size|width|inline-size|padding|margin|font|line|grid|content-visibility/;
      const ms = (v) => (v.trim().endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000) || 0;
      const longest = (el, pseudo) => {
        try { const cs = getComputedStyle(el, pseudo), d = cs.transitionDuration.split(','), l = cs.transitionDelay.split(',');
          return Math.max(0, ...d.map((x, i) => ms(x) + ms(l[i % l.length]))); } catch { return 0; }
      };
      let until = 0, following = false;
      const step = () => { snapAll(); if (performance.now() < until) requestAnimationFrame(step); else following = false; };
      const follow = (t) => { until = Math.max(until, performance.now() + Math.min(t + 50, 2000)); if (!following) { following = true; requestAnimationFrame(step); } };
      document.addEventListener('toggle', (e) => { if (page.contains(e.target)) follow(Math.max(longest(e.target, '::details-content'), longest(e.target))); }, true);
      page.addEventListener('transitionrun', (e) => { if (sizing.test(e.propertyName)) follow(longest(e.target, e.pseudoElement || null)); });
    }
    // the page hero, from 1200 wide, where the browser lacks CSS round(): calc(100svh - 69px) rounded down to 8px
    const grid = document.querySelector('.s-hero-grid');
    if (grid && !CSS.supports('height', 'round(down, 10px, 4px)')) {
      const fit = () => { grid.style.height = innerWidth >= 1200 ? `${Math.floor((innerHeight - 69) / 8) * 8}px` : ''; };
      fit(); addEventListener('resize', fit);
    }

    // 6. the closing band's card: its height a whole number of 16px (the dot field drawn in it by the site's dither.js sits 8 from every edge)
    const card = document.querySelector('.cta-card');
    if (card) {
      const fit16 = () => { card.style.minHeight = ''; const h = card.getBoundingClientRect().height; card.style.minHeight = `${Math.ceil(h / 16 - 0.01) * 16}px`; };
      // measured from scratch each time (min-height cleared first), so the card shrinks as well as grows; its children are watched too,
      // because a card held up by its min-height doesn't change size when its content gets shorter. Refit on the next frame, not inside the observer.
      let queued = false;
      const refit = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; fit16(); }); } };
      fit16(); const ro16 = new ResizeObserver(refit); ro16.observe(card); [...card.children].forEach((c) => ro16.observe(c));
    }
  });
})();
