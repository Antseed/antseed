// The launch nav (site-nav.css): the Providers menu (hover with a mouse, click, keyboard, Escape) and, under 1080 px, the phone menu.
{
const nav = document.querySelector('nav');
const dd = nav && nav.querySelector('.dd');
if (dd) {
  const t = dd.querySelector('.dd-t'), m = dd.querySelector('.dd-m');
  const set = (on) => { dd.classList.toggle('open', on); t.setAttribute('aria-expanded', String(on)); m.hidden = !on; };
  // under a mouse the menu is already open when the click comes (the hover opened it): the click keeps it open instead of closing it
  let over = false;
  t.addEventListener('click', () => set(over || m.hidden));
  t.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); set(true); m.querySelector('a').focus(); } });
  dd.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { over = true; set(true); } });
  dd.addEventListener('pointerleave', () => { over = false; if (!dd.contains(document.activeElement)) set(false); });
  dd.addEventListener('focusout', () => setTimeout(() => { if (!dd.contains(document.activeElement)) set(false); }, 0));
  document.addEventListener('click', (e) => { if (!dd.contains(e.target)) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.hidden) { set(false); t.focus(); } });
}
if (nav) {
  // The phone menu (under 1080 px): the burger in each page's nav opens a sheet under the nav, on the page's colour: the links at one
  // size, Providers' two pages under it, the two buttons at the foot. Closed by a link, Escape, a tap outside it, the burger again
  let btn = nav.querySelector('.menu-btn');
  if (!btn) { btn = Object.assign(document.createElement('button'), { type: 'button', className: 'menu-btn' }); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'site-menu'); nav.querySelector('.acts').append(btn); }
  btn.setAttribute('aria-label', 'Menu');
  const menu = Object.assign(document.createElement('div'), { id: 'site-menu', className: 'site-menu', hidden: true });
  // Providers' two pages with the client's shorter lines
  const short = { '/providers/': 'Your service, your price', '/colony/': 'Many computers. One provider.' };
  const prov = dd ? [...dd.querySelectorAll('.dd-m a')].map((a) => { const c = a.cloneNode(true), s = c.querySelector('span'), k = a.getAttribute('href'); if (s && short[k]) s.textContent = short[k]; return c.outerHTML; }).join('') : '';
  const ext = 'target="_blank" rel="noopener noreferrer"';
  menu.innerHTML = `<div class="sm-links"><a href="/network/">Network</a><a href="/providers/">Providers</a><div class="sm-sub">${prov}</div><a href="/ecosystem/">Ecosystem</a><a href="https://antseedstats.com/network" ${ext}>Live prices&nbsp;↗</a><a href="https://antseed.com/docs/">Docs</a><a href="https://antseed.com/blog/">Blog</a></div><div class="sm-acts"></div>`;
  // the nav's own two buttons, as they are (their links, their words), full width at the sheet's foot
  const acts = menu.querySelector('.sm-acts');
  for (const c of [nav.querySelector('.acts .cta:not(.ghost)'), nav.querySelector('.acts .cta.ghost')]) if (c) { const k = c.cloneNode(true); k.removeAttribute('id'); acts.append(k); }
  menu.querySelectorAll('.sm-links > a, .sm-sub a').forEach((a, i) => a.style.setProperty('--i', i));   // the rows unroll in turn (site-nav.css)
  document.body.append(menu);   // out of the nav: its glass (backdrop-filter) would hold a fixed sheet inside it
  const root = document.documentElement, calm = matchMedia('(prefers-reduced-motion: reduce)');
  let shut = 0;
  const open = (on) => {
    if (on) {   // under the nav, its rows lined up with the logo
      menu.style.setProperty('--sm-top', `${Math.max(0, nav.getBoundingClientRect().bottom)}px`);
      menu.style.setProperty('--sm-x', `${Math.max(16, nav.querySelector('a').getBoundingClientRect().left)}px`);
    }
    // closing: a quick fade, then hidden (at once with reduced motion, or if it was not open)
    clearTimeout(shut);
    if (on) { menu.classList.remove('closing'); menu.hidden = false; }
    else if (!menu.hidden && !calm.matches) { menu.classList.add('closing'); shut = setTimeout(() => { menu.hidden = true; menu.classList.remove('closing'); }, 140); }
    else menu.hidden = true;
    btn.setAttribute('aria-expanded', String(on)); btn.setAttribute('aria-label', on ? 'Close menu' : 'Menu');
    root.classList.toggle('menu-open', on);   // the page behind holds still (site-nav.css)
  };
  btn.addEventListener('click', () => open(menu.hidden || menu.classList.contains('closing')));
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.classList.contains('closing') && !menu.contains(e.target) && !btn.contains(e.target)) open(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden && !menu.classList.contains('closing')) { open(false); btn.focus(); } });
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) open(false); });
  matchMedia('(min-width: 1080px)').addEventListener('change', (e) => { if (e.matches) open(false); });
}
}
