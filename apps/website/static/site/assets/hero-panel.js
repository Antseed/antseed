// The settings panel shared by the live heroes (hero/ and its versions, hero-hybrid/).

// Each page keeps its own `const DEFAULTS = {…}` block and a live copy, S, that its drawing code reads.
// `settings` builds S at start (the file's values, plus what was last tuned in this browser);
// `heroPanel` is called last and binds the page's controls to S. A visitor needs none of it, so nothing of it loads with the page:
// Tweakpane (a CDN) and the page's copy of itself (for Copy settings) are fetched only once the panel is asked for, with P or ?panel,
// or because it was left open last time in this browser. From then on it is as it always was: folded, a small dot inside the hero, top
// right under the nav; open or folded is remembered across reloads and across the three pages; P toggles it.
// ?demo and ?still get neither panel nor saved values.

export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const params = new URLSearchParams(location.search);
export const capture = params.has('demo') || params.has('still');

// S: the file's values, plus this page's last tuned values (not for captures). A local file does not survive a reload.
export function settings(page, DEFAULTS) {
  const S = { ...DEFAULTS, ...(capture ? {} : store.get(`${page}.state`) || {}) };
  for (const k of Object.keys(S)) if (!(k in DEFAULTS)) delete S[k];
  if (S.source === 'file') S.source = DEFAULTS.source;
  return S;
}

// The watercolour's paper: the average of its pale, unsaturated pixels.
export function paperOf(img) {
  const w = 96, h = Math.max(1, Math.round(96 * img.height / img.width));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data, sum = [0, 0, 0];
  let n = 0;
  for (let p = 0; p < d.length; p += 4) {
    const mx = Math.max(d[p], d[p + 1], d[p + 2]), mn = Math.min(d[p], d[p + 1], d[p + 2]);
    if (mx > 235 && (mx - mn) / mx < 0.1) { sum[0] += d[p]; sum[1] += d[p + 1]; sum[2] += d[p + 2]; n++; }
  }
  if (!n) return null;
  return '#' + sum.map((v) => Math.round(v / n).toString(16).padStart(2, '0')).join('');
}

// The panel. page: names this page's saved values and presets ('meadow', 'sky', 'hybrid').
// schema: folders of controls, each control one of
//   [key, min, max, step, label?] a slider
//   [key, label?] a colour, a switch or a text, from the value's type
//   [key, { …Tweakpane params }] anything else (a list: { label, options })
//   { button: 'Replace image…', file: true } the local-file picker; the image goes to onFile(img)
// apply(key): one setting changed. applyAll: many did (a preset, Reset). onFile(img): a local image was picked.
export async function heroPanel(opts) {
  if (capture) return null;
  const { page, S, applyAll } = opts;
  // what the page holds from the start: refresh reaches the panel once there is one
  let real = null, loading = null;
  const handle = { pane: null, refresh() { real?.refresh(); } };
  const isP = (e) => e.key?.toLowerCase() === 'p' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target.closest?.('input, textarea, select');
  const ask = (e) => { if (isP(e)) { removeEventListener('keydown', ask); load(true); } };   // the first P builds it, open; after that the panel's own P toggles it
  const load = (open) => (loading ||= build(opts, open).then((r) => { real = r; handle.pane = r.pane; },
    (err) => { loading = null; addEventListener('keydown', ask); console.warn('settings panel not loaded', err); }));
  // console access for scripted tuning, panel or not: hero.S, then hero.refresh
  window.hero = { S, refresh() { real?.refresh(); store.set(`${page}.state`, S); applyAll(); } };
  if (params.has('panel')) await load(true);
  else if (store.get('hero.panel.open')) await load();
  else addEventListener('keydown', ask);
  return handle;
}

async function build({ page, title, DEFAULTS, S, schema, apply, applyAll, onFile }, open) {
  const { Pane } = await import('https://cdn.jsdelivr.net/npm/tweakpane@4.0.5/dist/tweakpane.min.js');
  style();
  const hero = document.getElementById('hero');
  const dot = Object.assign(document.createElement('button'), { type: 'button', className: 'hp-dot', title: 'Settings (P)' });
  dot.setAttribute('aria-label', 'Open settings');
  const box = Object.assign(document.createElement('div'), { className: 'hp-panel' });
  const close = Object.assign(document.createElement('button'), { type: 'button', className: 'hp-close', textContent: '×' });
  close.setAttribute('aria-label', 'Fold settings');
  const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
  document.body.append(dot, box, fileInput);

  // the dot and the panel sit over the hero's top right corner, under the nav
  const place = () => {
    const r = hero.getBoundingClientRect(), top = r.top + scrollY + 72, right = innerWidth - (r.right + scrollX) + 16;
    for (const el of [dot, box]) { el.style.top = `${top}px`; el.style.right = `${right}px`; }
    box.style.maxHeight = `${Math.max(160, r.bottom + scrollY - top - 16)}px`;
  };
  place(); addEventListener('resize', place);

  const pane = new Pane({ container: box, title });
  box.append(close);
  const setOpen = (open) => { box.hidden = !open; dot.hidden = open; store.set('hero.panel.open', open); };
  setOpen(open ?? !!store.get('hero.panel.open'));
  dot.addEventListener('click', () => setOpen(true));
  close.addEventListener('click', () => setOpen(false));
  // the title bar folds it back to the dot too (instead of Tweakpane's own collapse)
  box.querySelector('.tp-rotv_b')?.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); setOpen(false); }, true);
  addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'p' || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
    setOpen(box.hidden);
  });

  // Refreshing the panel fires its change events; while the page itself moved a value (a preset, the paper read
  // off the image) those are not the person's changes, so they only save.
  let quiet = false;
  const save = () => store.set(`${page}.state`, S);
  const refresh = () => { quiet = true; pane.refresh(); quiet = false; };
  pane.on('change', (ev) => { save(); if (!quiet && ev.target?.key) apply(ev.target.key); });

  // presets: Default (the file's values), and yours, kept in this browser for this page
  const presets = store.get(`${page}.presets`) || {};
  const presetOptions = () => [{ text: 'Default', value: 'default' }, ...Object.keys(presets).map((k) => ({ text: `★ ${k}`, value: k }))];
  const presetList = pane.addBlade({ view: 'list', label: 'preset', options: presetOptions(), value: 'default' });
  const use = (values) => {
    Object.assign(S, DEFAULTS, values);
    for (const k of Object.keys(S)) if (!(k in DEFAULTS)) delete S[k];
    if (S.source === 'file' && !hasFile) S.source = DEFAULTS.source;
    refresh(); save(); applyAll();
  };
  presetList.on('change', (ev) => use(ev.value === 'default' ? {} : presets[ev.value]));
  pane.addButton({ title: 'Save as preset' }).on('click', () => {
    const name = prompt('Preset name');
    if (!name) return;
    presets[name] = { ...S }; store.set(`${page}.presets`, presets);
    presetList.options = presetOptions(); presetList.value = name;
  });
  pane.addButton({ title: 'Reset' }).on('click', () => (presetList.value === 'default' ? use({}) : (presetList.value = 'default')));
  // Copy settings: the page's DEFAULTS block, as written in its file, with the current values in place
  const source = await fetch(location.pathname).then((r) => r.text()).catch(() => '');
  const block = source.match(/const DEFAULTS = \{[\s\S]*?\n\};/)?.[0];
  const literal = (v) => (typeof v === 'string' ? `'${v}'` : typeof v === 'number' ? String(+v.toFixed(4)) : String(v));
  const bCopy = pane.addButton({ title: 'Copy settings' });
  bCopy.on('click', async () => {
    const value = (k) => literal(k === 'source' && S.source === 'file' ? DEFAULTS.source : S[k]);
    const text = block ? block.replace(/\b(\w+): ('[^']*'|-?[\d.]+|true|false)/g, (m, k) => (k in S ? `${k}: ${value(k)}` : m))
      : `const DEFAULTS = ${JSON.stringify(S, null, 2)};`;
    try { await navigator.clipboard.writeText(text); bCopy.title = 'Copied'; } catch { bCopy.title = 'Copy failed'; console.log(text); }
    setTimeout(() => { bCopy.title = 'Copy settings'; }, 1200);
  });

  // the page's controls
  for (const { folder, expanded = false, controls } of schema) {
    const f = pane.addFolder({ title: folder, expanded });
    for (const c of controls) {
      if (!Array.isArray(c)) { f.addButton({ title: c.button }).on('click', () => fileInput.click()); continue; }
      const [key, a, b, step, label] = c;
      const opts = typeof a === 'number' ? { min: a, max: b, step, ...(label ? { label } : {}) } : typeof a === 'string' ? { label: a } : a || {};
      f.addBinding(S, key, opts);
    }
  }

  // Replace image…: a local file, sampled like the plates, until the page reloads
  let hasFile = false;
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    const img = new Image(); img.src = URL.createObjectURL(f);
    try { await img.decode(); } catch { return; }
    hasFile = true; await onFile(img); refresh(); save();
  });

  // console access for scripted tuning: hero.S, then hero.refresh
  window.hero = { S, refresh() { refresh(); save(); applyAll(); } };
  return { pane, refresh };
}

function style() {
  if (document.getElementById('hp-style')) return;
  const s = document.createElement('style'); s.id = 'hp-style';
  s.textContent = `
    .hp-dot { position: absolute; z-index: 60; display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%;
      cursor: pointer; background: rgba(255, 255, 255, .92); box-shadow: inset 0 0 0 0.5px #c3c3c3, 0 2px 8px rgba(4, 23, 15, .1); }
    .hp-dot::after { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #0a1a12; transition: transform .15s; }
    .hp-dot:hover::after { transform: scale(1.5); }
    .hp-dot:focus-visible { outline: 2px solid #c8f53c; outline-offset: 4px; }
    .hp-panel { position: absolute; z-index: 60; width: 300px; overflow-y: auto; border-radius: 8px; }
    .hp-close { position: absolute; top: 0; right: 0; width: 28px; height: 24px; padding: 0; border: 0; background: none; cursor: pointer;
      color: var(--tp-container-foreground-color, hsla(230, 7%, 75%, 1)); font: 16px/24px system-ui, sans-serif; }
    .hp-dot[hidden], .hp-panel[hidden] { display: none; }`;
  document.head.append(s);
}
