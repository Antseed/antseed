/* The animatable parts of one step's drawing, found by their layer names (data-n). Each beat is a group "Beat N · …": its flows
   ("Flow / …" paths) draw from source to destination behind a mask with a dot riding their head; what follows a flow in the group
   (arrowhead, pill, label) shows once it has arrived; a lookup's hops show as the line passes them. Parts fade through
   `data-fade` / `data-hidden` (styled in NetworkBoard.module.css). A flow's amount (its pill) stays in place but hidden (`data-home`):
   a copy rides the flow instead (rider.ts). */

const NS = 'http://www.w3.org/2000/svg';
const HOP_SAMPLES = 200;
const DOT_RADIUS = 5;
const MASK_PEN_EXTRA = 8;   // the mask's pen is wider than the line it reveals
const LIME = /^#c8f53c$/i;
const LIME_DOT = '#5F8A12';   // a lime line's dot, darker so it reads on the slab

/** How far each slab is lifted (in drawing units) while each step shows. */
const SLAB_LIFTS: Record<string, readonly number[]> = {'Slab / DHT': [0, -161, -161], 'Slab / Base': [0, 0, -161]};
/** Beats whose flows go in groups: one must land before the others leave (by flow index). */
const FLOW_GROUPS: Record<string, readonly (readonly number[])[]> = {'recognized usage': [[0], [1, 2, 3]], scores: [[0, 1, 2], [3]]};

export type Flow = {
  path: SVGPathElement; length: number; pen: SVGPathElement; dot: SVGCircleElement; maskId: string;
  after: Element[]; hops: {el: Element; at: number}[]; pill: SVGGElement | null;
};
export type Beat = {group: SVGGElement; flows: Flow[]; lead: Element[]; groups: Flow[][]};
export type Slab = {el: SVGGElement; lifts: readonly number[]};
export type Drawing = {svg: SVGSVGElement; beats: Beat[]; links: Element[]; slabs: Slab[]; dispose(): void};

const layer = (el: Element) => el.getAttribute('data-n') ?? '';
export const hide = (el: Element, hidden: boolean) => (hidden ? el.setAttribute('data-hidden', '') : el.removeAttribute('data-hidden'));
const attrs = (el: Element, values: Record<string, string | number>) => Object.entries(values).forEach(([k, v]) => el.setAttribute(k, String(v)));

function closestPoint(path: SVGPathElement, length: number, x: number, y: number): number {
  let best = 0;
  let distance = Infinity;
  for (let i = 0; i <= HOP_SAMPLES; i++) {
    const p = path.getPointAtLength(length * i / HOP_SAMPLES);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < distance) { distance = d; best = i / HOP_SAMPLES; }
  }
  return best;
}

/** Finds the beats, flows, links and slabs of `svg` and adds the masks and dots the animation needs; `dispose()` takes them away. */
export function prepareDrawing(svg: SVGSVGElement, index: number): Drawing {
  const added: Element[] = [];
  const faded: Element[] = [];
  const defs = svg.querySelector('defs') ?? svg.appendChild(document.createElementNS(NS, 'defs'));
  const fade = (el: Element) => { el.setAttribute('data-fade', ''); faded.push(el); };

  const links = [...svg.querySelectorAll('[data-n^="Links /"], [data-n="Scene · ports"]')];
  links.forEach(fade);
  const slabs = Object.entries(SLAB_LIFTS).flatMap(([name, lifts]) => {
    const el = svg.querySelector<SVGGElement>(`[data-n="${name}"]`);
    return el ? [{el, lifts}] : [];
  });

  const beats = [...svg.querySelectorAll<SVGGElement>('g[data-n^="Beat"]')].map((group, b): Beat => {
    const flows: Flow[] = [];
    const lead: Element[] = [];
    for (const el of [...group.children]) {
      fade(el);
      if (layer(el).startsWith('Flow /') && el instanceof SVGPathElement) {
        const maskId = `net${index + 1}-m${b}-${flows.length}`;
        const mask = document.createElementNS(NS, 'mask');
        attrs(mask, {id: maskId, maskUnits: 'userSpaceOnUse', x: -100, y: 0, width: 1500, height: 1100});
        const pen = document.createElementNS(NS, 'path');
        attrs(pen, {d: el.getAttribute('d') ?? '', stroke: '#fff', fill: 'none', pathLength: 1, 'stroke-dasharray': '1 1',
          'stroke-width': (Number(el.getAttribute('stroke-width')) || 1) + MASK_PEN_EXTRA});
        mask.append(pen);
        defs.append(mask);
        const dot = document.createElementNS(NS, 'circle');
        const ink = el.getAttribute('stroke') ?? '';
        attrs(dot, {r: DOT_RADIUS, fill: LIME.test(ink) ? LIME_DOT : ink, 'data-fade': '', 'data-hidden': '', 'data-dot': ''});
        added.push(mask, dot);
        flows.push({path: el, length: el.getTotalLength(), pen, dot, after: [], hops: [], pill: null, maskId});
      } else if (flows.length) flows[flows.length - 1].after.push(el);
      else lead.push(el);
    }
    for (const f of flows) {
      const isHop = (el: Element) => layer(el).startsWith('hop');
      f.hops = f.after.filter(isHop).map((el) => ({el, at: closestPoint(f.path, f.length, Number(el.getAttribute('cx')), Number(el.getAttribute('cy')))}));
      f.after = f.after.filter((el) => !isHop(el));
      f.pill = f.after.find((el): el is SVGGElement => layer(el).startsWith('Pill /')) ?? null;
      if (f.pill) { f.pill.setAttribute('data-home', ''); f.after = f.after.filter((el) => el !== f.pill); }
      group.append(f.dot);
    }
    const order = Object.entries(FLOW_GROUPS).find(([name]) => layer(group).includes(name))?.[1];
    const fits = order && order.every((g) => g.every((i) => flows[i])) && order.flat().length === flows.length;
    return {group, flows, lead, groups: fits ? order.map((g) => g.map((i) => flows[i])) : [flows]};
  });

  return {
    svg, beats, links, slabs,
    dispose() {
      added.forEach((el) => el.remove());
      svg.querySelectorAll('[data-rider]').forEach((el) => el.remove());
      beats.forEach((bt) => bt.flows.forEach((f) => f.pill?.removeAttribute('data-home')));
      faded.forEach((el) => { el.removeAttribute('data-fade'); el.removeAttribute('data-hidden'); });
      beats.forEach((bt) => bt.flows.forEach((f) => f.path.removeAttribute('mask')));
      slabs.forEach((s) => s.el.removeAttribute('transform'));
    },
  };
}

/** Reveals a flow up to `p` (0..1) of its length. */
export function drawFlow(f: Flow, p: number): void {
  if (p >= 1) { f.path.removeAttribute('mask'); return; }
  f.path.setAttribute('mask', `url(#${f.maskId})`);
  f.pen.setAttribute('stroke-dashoffset', String(1 - p));
}

/** Every beat hidden, every flow undrawn. */
export function blank(d: Drawing): void {
  for (const bt of d.beats) {
    for (const el of bt.group.children) hide(el, true);
    bt.flows.forEach((f) => drawFlow(f, 0));
  }
}

/** Every beat shown and drawn (the dots hidden). */
export function complete(d: Drawing): void {
  for (const bt of d.beats) {
    for (const el of bt.group.children) hide(el, el.hasAttribute('data-dot'));
    bt.flows.forEach((f) => drawFlow(f, 1));
  }
}

/** The slabs' current lift, read back from their transforms. */
export function currentLifts(d: Drawing): number[] {
  return d.slabs.map((s) => Number(s.el.getAttribute('transform')?.match(/translate\(0 (-?[\d.]+)/)?.[1] ?? 0));
}

export function liftSlabs(d: Drawing, lifts: readonly number[]): void {
  d.slabs.forEach((s, i) => (lifts[i] ? s.el.setAttribute('transform', `translate(0 ${lifts[i].toFixed(2)})`) : s.el.removeAttribute('transform')));
}

/** Slabs at rest; the links and ports shown once they are. */
export function rest(d: Drawing, lifts: readonly number[] = [], linked = true): void {
  liftSlabs(d, lifts);
  d.links.forEach((el) => hide(el, !linked));
}
