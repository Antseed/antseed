/* The drawings are shown well under their authored size, so their upright labels, pills and score chips are enlarged in place to stay
   readable. Labels are taken in stacks (a name over its note or pill: same left or right edge, one under the other), each growing from
   the edge it is aligned on, a lone label from the side facing the drawing's middle. A cube's name is first set under its cube, plumb
   with the cube's front edge, so it sits at the same place in every step. Slab names (rotated) grow along their edge; a pool's name
   (white, on its tile) keeps its size and is centred on its tile. */

type Side = 'l' | 'r' | 'm';
type Item = {el: SVGGraphicsElement; l: number; r: number; t: number; b: number; sx: number; sy: number; cube?: 'l' | 'r'};
type Stack = {items: Item[]; side: Side; ax: number; ay: number; dx: number; cube: boolean};
export type Labels = {stacks: Stack[]; names: {el: Element; size: number}[]; reset(): void};

const MIN_READ_PX = 11;      // a label is drawn at least this high on screen…
const MAX_GROW = 1.75;       // …up to this many times its size
const MAX_NAME_GROW = 1.4;   // slab names
const LABEL_SIZE = 13;       // the drawing's label font size
const CUBE_GAP = 8;          // between a cube's bottom corner and its name
const DRAWING_MIDDLE = [560, 680];   // a lone label left of this grows rightwards, right of it leftwards
const BUYERS_EDGE = 1240;    // cubes left of this (sum of both faces' x) are buyers
const SIDE_OF: Record<string, Side> = {'Pill / 10 USDC': 'l'};
const TILE_MAX_WIDTH = 80;   // a pool's tile, among its slab's shapes
const CAP_CENTRE = .36;      // the baseline below a line's middle, in font sizes

const layer = (el: Element) => el.getAttribute('data-n') ?? '';

export function collectLabels(svg: SVGSVGElement): Labels {
  const els = new Set<SVGGraphicsElement>(svg.querySelectorAll<SVGGraphicsElement>('g[data-n^="Pill"], rect[data-n="score highlight"]'));
  for (const t of svg.querySelectorAll<SVGTextElement>('text:not([transform])')) {
    if (t.closest('[data-n^="Pill"]')) continue;
    const p = t.parentElement as unknown as SVGGElement;
    const textStack = p.children.length > 1 && [...p.children].every((c) => c.tagName === 'text') && !/^(Scene|Beat|Cube|Holders|Slab)/.test(layer(p));
    els.add(textStack ? p : t);
  }
  const items: Item[] = [...els].map((el) => { const b = el.getBBox(); return {el, l: b.x, r: b.x + b.width, t: b.y, b: b.y + b.height, sx: 0, sy: 0}; });

  for (const cube of svg.querySelectorAll('[data-n^="Cube /"]')) {
    const name = items.find((it) => it.el.tagName === 'text' && cube.contains(it.el));
    const face = (end: string) => ([...cube.children].find((c) => (c.getAttribute('fill') ?? '').endsWith(end)) as SVGGraphicsElement | undefined)?.getBBox();
    const fl = face('-l)');
    const fr = face('-r)');
    if (!name || !fl || !fr) continue;
    const buyer = fl.x + fr.x < BUYERS_EDGE;
    const edge = buyer ? 'r' : 'l';
    const dx = fl.x + fl.width - name[edge];
    const dy = fl.y + fl.height + CUBE_GAP - name.t;
    const stack = [name];
    for (let next = name as Item | undefined; next;) {
      const last = stack[stack.length - 1];
      next = items.find((it) => !stack.includes(it) && Math.abs(it[edge] - name[edge]) < 8 && it.t > last.t && it.t < last.b + 24);
      if (next) stack.push(next);
    }
    for (const it of stack) { it.sx = dx; it.sy = dy; it.l += dx; it.r += dx; it.t += dy; it.b += dy; }
    name.cube = buyer ? 'r' : 'l';
  }

  // union-find: items aligned on an edge and close above/below each other form one stack
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  items.forEach((a, i) => items.slice(i + 1).forEach((c, k) => {
    const j = i + 1 + k;
    if ((Math.abs(a.l - c.l) < 7 || Math.abs(a.r - c.r) < 7) && Math.max(a.t, c.t) - Math.min(a.b, c.b) < 14) parent[find(i)] = find(j);
  }));
  const groups = new Map<number, Item[]>();
  items.forEach((it, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), it]));

  const stacks = [...groups.values()].map((st): Stack => {
    st.sort((a, c) => a.t - c.t);
    const L = Math.min(...st.map((i) => i.l));
    const R = Math.max(...st.map((i) => i.r));
    const mid = (L + R) / 2;
    const named = st.find((i) => i.cube);
    if (named?.cube) return {items: st, side: named.cube, ax: named[named.cube], ay: (named.t + named.b) / 2, dx: 0, cube: true};
    const side = st.map((i) => SIDE_OF[layer(i.el)]).find(Boolean) ?? (mid < DRAWING_MIDDLE[0] ? 'r' : mid > DRAWING_MIDDLE[1] ? 'l' : 'm');
    return {items: st, side, ax: side === 'l' ? L : side === 'r' ? R : mid, ay: (st[0].t + st[0].b) / 2, dx: 0, cube: false};
  });
  const flat = [...svg.querySelectorAll<SVGTextElement>('[data-n^="Slab /"] > text[transform]')];
  const isPool = (t: Element) => t.getAttribute('fill') === 'white';
  const restorePools = flat.filter(isPool).map(centreOnTile);
  const names = flat.filter((t) => !isPool(t)).map((el) => ({el, size: Number(el.getAttribute('font-size'))}));
  return {
    stacks, names,
    reset() {
      restorePools.forEach((restore) => restore());
      stacks.forEach((st) => st.items.forEach((i) => i.el.removeAttribute('transform')));
      names.forEach((n) => n.el.setAttribute('font-size', String(n.size)));
    },
  };
}

/** Centres a pool's name on the nearest small tile of its slab, in the text's own (rotated) coordinates; returns the undo. */
function centreOnTile(t: SVGTextElement): () => void {
  const m = t.transform.baseVal.consolidate()?.matrix;
  const span = t.querySelector('tspan');
  const tiles = [...(t.parentElement?.children ?? [])].filter((c): c is SVGPathElement => c instanceof SVGPathElement)
    .map((c) => { const b = c.getBBox(); return {x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width}; })
    .filter((c) => c.w < TILE_MAX_WIDTH);
  if (!m || !span || !tiles.length) return () => {};
  const near = tiles.sort((a, c) => Math.hypot(a.x - m.e, a.y - m.f) - Math.hypot(c.x - m.e, c.y - m.f))[0];
  const dx = near.x - m.e;
  const dy = near.y - m.f;
  const det = m.a * m.d - m.b * m.c;
  const was = {anchor: t.getAttribute('text-anchor'), x: span.getAttribute('x'), y: span.getAttribute('y')};
  t.setAttribute('text-anchor', 'middle');
  span.setAttribute('x', ((m.d * dx - m.c * dy) / det).toFixed(2));
  span.setAttribute('y', ((-m.b * dx + m.a * dy) / det + Number(t.getAttribute('font-size')) * CAP_CENTRE).toFixed(2));
  return () => {
    if (was.anchor === null) t.removeAttribute('text-anchor'); else t.setAttribute('text-anchor', was.anchor);
    span.setAttribute('x', was.x ?? '0');
    span.setAttribute('y', was.y ?? '0');
  };
}

/** Enlarges the labels for the drawing's on-screen `scale` (screen px per drawing unit). */
export function fitLabels(labels: Labels, scale: number): void {
  const k = Math.max(1, Math.min(MAX_GROW, MIN_READ_PX / (LABEL_SIZE * scale)));
  const grown = (st: Stack) => ({
    l: Math.min(...st.items.map((i) => st.ax + (i.l - st.ax) * k)) + st.dx, r: Math.max(...st.items.map((i) => st.ax + (i.r - st.ax) * k)) + st.dx,
    t: Math.min(...st.items.map((i) => st.ay + (i.t - st.ay) * k)), b: Math.max(...st.items.map((i) => st.ay + (i.b - st.ay) * k)),
  });
  // at the right, a stack that would run into one nearer the drawing moves further out
  const outer = labels.stacks.filter((st) => st.side === 'l' && st.ax > 860 && !st.cube).sort((a, c) => a.ax - c.ax);
  outer.forEach((st, n) => {
    st.dx = 0;
    for (const near of outer.slice(0, n)) {
      const a = grown(near);
      const c = grown(st);
      if (c.l < a.r + 6 && c.t < a.b + 2 && a.t < c.b + 2) st.dx += a.r + 8 - c.l;
    }
  });
  for (const st of labels.stacks) for (const i of st.items) {
    const shift = i.sx || i.sy ? `translate(${i.sx.toFixed(2)} ${i.sy.toFixed(2)})` : '';
    const grow = k > 1 ? `translate(${(st.ax + st.dx).toFixed(2)} ${st.ay.toFixed(2)}) scale(${k.toFixed(3)}) translate(${(-st.ax).toFixed(2)} ${(-st.ay).toFixed(2)})` : '';
    const transform = [grow, shift].filter(Boolean).join(' ');
    if (transform) i.el.setAttribute('transform', transform);
    else i.el.removeAttribute('transform');
  }
  for (const n of labels.names) n.el.setAttribute('font-size', (n.size * Math.min(k, MAX_NAME_GROW)).toFixed(2));
}
