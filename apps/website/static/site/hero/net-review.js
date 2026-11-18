// Review aid, to delete once Elio has picked (17 Nov): the network's board as the layered diagram or the painted map, in place, on the
// homepage (#network) and on the network page. ?net=diagram or ?net=map (the map by default) names the part its slot asks for; a small
// "Diagram / Map" switch in the board's top right corner reloads the page with the other. Imported before parts.js, so the slot is set before it fills.
// To remove: this file, its import on hero/index.html and network/index.html, and keep the slot's data-part that won.
const PARTS = { diagram: { home: 'layers', page: 'layers-large' }, map: { home: 'net-map', page: 'net-map' } };
const params = new URLSearchParams(location.search);
const pick = params.get('net') === 'diagram' ? 'diagram' : 'map';
const slot = document.querySelector('.s-net-panel > .lp-slot, .nw-panel > .lp-slot');

if (slot) {
  const part = PARTS[pick][slot.classList.contains('lp-slot--layers') ? 'home' : 'page'];
  slot.dataset.part = part;
  document.body.dataset.parts = [...(document.body.dataset.parts || '').split(','), part].filter(Boolean).join(',');

  const css = document.createElement('style');
  css.textContent = `
.net-review { position: absolute !important; inset: 8px 8px auto auto !important; width: auto !important; height: auto !important; min-height: 0 !important; aspect-ratio: auto !important; margin: 0 !important; z-index: 5; display: flex !important;   /* over the panels' rules that hide what is not the board */ gap: 4px; padding: 4px; border-radius: 12px;
  background: rgba(255, 255, 255, .72); box-shadow: 0 0 0 .5px rgba(10, 26, 18, .12); font: 500 12px/16px "Geist Mono", ui-monospace, monospace; }
:root[data-theme="dark"] .net-review { background: rgba(14, 33, 23, .72); box-shadow: 0 0 0 .5px rgba(150, 200, 145, .3); }
.net-review a { display: flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 8px; color: #646b67; text-decoration: none; }
.net-review a[aria-current] { background: rgba(10, 26, 18, .06); color: #1b211e; }
:root[data-theme="dark"] .net-review a { color: #a4aba7; }
:root[data-theme="dark"] .net-review a[aria-current] { background: rgba(255, 255, 255, .08); color: #f5f7f5; }`;
  document.head.append(css);

  const bar = document.createElement('nav');
  bar.className = 'net-review';
  bar.setAttribute('aria-label', 'Network board version (review)');
  for (const [key, label] of [['diagram', 'Diagram'], ['map', 'Map']]) {
    const p = new URLSearchParams(location.search);
    p.set('net', key);
    const a = Object.assign(document.createElement('a'), { href: `?${p}${slot.classList.contains('lp-slot--layers') ? '#network' : ''}`, textContent: label });
    if (key === pick) a.setAttribute('aria-current', 'true');
    bar.append(a);
  }
  slot.parentElement.append(bar);   // in the panel's top right corner, over the painting's paper edge
}
