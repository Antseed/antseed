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
  // the button is in each page's nav already (this script is deferred: added here, it pushed the nav's right side across on a phone's
  // first frame); made here only where a page has none
  let btn = nav.querySelector('.menu-btn');
  if (!btn) { btn = Object.assign(document.createElement('button'), { type: 'button', className: 'menu-btn', textContent: 'Menu' }); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'site-menu'); }
  const menu = Object.assign(document.createElement('div'), { id: 'site-menu', className: 'site-menu', hidden: true });
  // The phone menu takes the dropdown's links with the client's shorter lines
  const short = { '/providers/': 'Your service, your price', '/colony/': 'Many computers. One provider.' };
  const prov = dd ? [...dd.querySelectorAll('.dd-m a')].map((a) => { const c = a.cloneNode(true), s = c.querySelector('span'), k = a.getAttribute('href'); if (s && short[k]) s.textContent = short[k]; return c.outerHTML; }).join('') : '';
  menu.innerHTML = `<a href="/network/">Network</a><p>Providers</p>${prov}<p>More</p><a href="/ecosystem/">Ecosystem</a><a href="https://antseedstats.com/network" target="_blank" rel="noopener noreferrer">Live prices ↗</a><a href="https://antseed.com/docs/">Docs ↗</a><a href="https://antseed.com/blog/">Blog ↗</a><a href="https://t.me/antseed" target="_blank" rel="noopener noreferrer">Telegram ↗</a><a href="https://github.com/Antseed/antseed" target="_blank" rel="noopener noreferrer">GitHub ↗</a>`;
  if (!btn.isConnected) nav.querySelector('.acts').append(btn);
  nav.append(menu);
  const open = (on) => { menu.hidden = !on; btn.setAttribute('aria-expanded', String(on)); btn.textContent = on ? 'Close' : 'Menu'; };
  btn.addEventListener('click', () => open(menu.hidden));
  document.addEventListener('click', (e) => { if (!nav.contains(e.target)) open(false); });
  nav.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { open(false); btn.focus(); } });
  menu.addEventListener('click', (e) => { if (e.target.closest('a')) open(false); });
  matchMedia('(min-width: 1080px)').addEventListener('change', (e) => { if (e.matches) open(false); });
}
}
