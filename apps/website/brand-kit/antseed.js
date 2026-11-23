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
      const open = (on) => {
        if (on) { menu.style.setProperty('--sm-top', `${Math.max(0, nav.getBoundingClientRect().bottom)}px`);
          menu.style.setProperty('--sm-x', `${Math.max(16, nav.querySelector('a').getBoundingClientRect().left)}px`); }
        menu.hidden = !on; btn.setAttribute('aria-expanded', String(on)); btn.setAttribute('aria-label', on ? 'Close menu' : 'Menu');
        root.classList.toggle('menu-open', on);
      };
      btn.addEventListener('click', () => open(menu.hidden));
      menu.addEventListener('click', (e) => { if (e.target.closest('a')) open(false); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { open(false); btn.focus(); } });
      matchMedia('(min-width: 1080px)').addEventListener('change', (e) => { if (e.matches) open(false); });
    }

    // 5. every section a multiple of 8px tall, so each top and its dotted line land on a row of the margin's dots.
    //    The closing band and the footer are left as they are (as on the live site).
    const snap = (sec) => { sec.style.minHeight = ''; const h = sec.getBoundingClientRect().height, to = Math.ceil(h / 8 - 0.02) * 8; if (to > h) sec.style.minHeight = `${to}px`; };
    const secs = [...document.querySelectorAll('.s-page > .s-sec:not(.cta-band, .s-foot)')];
    const ro = new ResizeObserver((list) => list.forEach((e) => snap(e.target)));
    secs.forEach((s) => ro.observe(s));
    document.fonts.ready.then(() => secs.forEach(snap));
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
      fit16(); new ResizeObserver(() => { if (card.getBoundingClientRect().height % 16) fit16(); }).observe(card);
    }
  });
})();
