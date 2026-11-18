// The launch's visual parts: each slot <div class="lp-slot" data-part="name"> is filled with parts/name.html,
// its style parts/name.css linked once. A fragment whose root carries data-js gets parts/name.js run on it (export default (el) => {}).
// Only the parts listed on <body data-parts="a,b"> load (they are listed as they are merged), so an empty slot asks for nothing.
// ?parts=a,b loads others too, to look at a part in place before it is listed. A filled slot gets .lp-on (launch.css lets the
// panel's own picture step back where it should).
// A slot left empty (its part not listed, or not loaded) marks its panel .lp-miss: the panel shows what it had (launch.css gives the
// network's old board its painting back).
const listed = (document.body.dataset.parts || '').split(',');
const asked = (new URLSearchParams(location.search).get('parts') || '').split(',');
const want = new Set([...listed, ...asked].map((s) => s.trim()).filter(Boolean));
const base = new URL('parts/', import.meta.url);
const linked = new Set();

async function fill(slot) {
  const name = slot.dataset.part, miss = () => slot.parentElement.classList.add('lp-miss');
  if (!want.has(name)) return miss();
  try {
    const r = await fetch(new URL(`${name}.html`, base));
    if (!r.ok) return miss();
    if (!linked.has(name)) {
      linked.add(name);
      document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL(`${name}.css`, base).href }));
    }
    slot.innerHTML = await r.text();
    slot.classList.add('lp-on');
    slot.parentElement.classList.add('lp-has');
    const root = slot.querySelector('[data-js]');
    if (root) (await import(new URL(`${name}.js`, base).href)).default?.(slot);
  } catch (err) { if (!slot.classList.contains('lp-on')) miss(); console.warn('part not loaded', name, err); }
}

document.querySelectorAll('.lp-slot[data-part]').forEach(fill);
