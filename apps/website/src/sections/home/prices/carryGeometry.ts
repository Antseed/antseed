/* Where each carrying ant sits on its card and how it walks, from its sprite sheet's table (static/site/assets/home/carry/*.json).
   A sheet holds one row of cells per layer (the ant behind the card, its hand over it): the walk frames, a run frame, then stand,
   look and hop. Everything is scaled from the card the sheet was drawn for to the card on screen. */
import ant from '@site/static/site/assets/home/carry/ant.json';
import young from '@site/static/site/assets/home/carry/young.json';
import glasses from '@site/static/site/assets/home/carry/glasses.json';
import bandana from '@site/static/site/assets/home/carry/bandana.json';
import headphones from '@site/static/site/assets/home/carry/headphones.json';

type SheetTable = {
  cell: number[]; card: number; walk: number; stand: number; look: number; hop: number;
  /** Where the card's lower-left corner sits in a cell, and where the feet are. */
  corner: number[]; ground: number;
  /** How far the card rises on each frame so the feet stay on the ground. */
  lift: number[];
  /** px walked on each walk frame. */
  steps: number[];
};

type Carrier = {sheet: string; table: SheetTable; scale: number};

/** The five carriers, each its own sheet and size; the first is the default worker. */
const CARRIERS: readonly Carrier[] = [
  {sheet: 'ant', table: ant, scale: 1},
  {sheet: 'young', table: young, scale: 0.9},
  {sheet: 'glasses', table: glasses, scale: 1.06},
  {sheet: 'bandana', table: bandana, scale: 0.97},
  {sheet: 'headphones', table: headphones, scale: 1.02},
];

/** Half the carriers walk in front of their card, half behind it with a hand over its edge. */
const SHARE_AHEAD = 0.5;

export type WalkCycle = {from: number[]; length: number};

export type Frames = {
  /** background-position of the ant and of its hand, per frame. */
  back: string[];
  hand: string[];
  lift: number[];
  walk: WalkCycle;
  walkFrames: number;
  stand: number;
  look: number;
  hop: number;
};

export type Fit = {
  vars: Record<string, string>;
  /** How far the feet go below the card, and how far the ant reaches past the card's trailing and leading sides. */
  below: number;
  behind: number;
  beyond: number;
  frames: Frames;
};

const px = (n: number) => `${n.toFixed(2)}px`;

/** Carrier `c` on a card of `side` px; `mirrored` for the lane walking left. */
function fit(c: Carrier, side: number, mirrored: boolean): Fit {
  const t = c.table;
  const g = side / t.card * c.scale;
  const [cw, ch] = t.cell;
  const [x, y] = t.corner;
  const ax = mirrored ? side - (cw - x) * g : -x * g;
  const ax0 = -x * g;
  const at = (n: number, row: number) => `${px(-n * cw * g)} ${px(-row * ch * g)}`;
  let gone = 0;
  const from = t.steps.map((s) => { const a = gone; gone += s * g; return a; });
  return {
    vars: {'--sheet': `url(/site/assets/home/carry/${c.sheet}.webp)`, '--ant-w': px(cw * g), '--ant-h': px(ch * g), '--ant-x': px(ax),
      '--ant-y': px(side - y * g), '--sheet-w': px(cw * g * t.lift.length), '--sheet-h': px(ch * g * 2)},
    below: (t.ground - y) * g,
    behind: Math.max(0, -ax0),
    beyond: Math.max(0, ax0 + cw * g - side),
    frames: {back: t.lift.map((_, n) => at(n, 0)), hand: t.lift.map((_, n) => at(n, 1)), lift: t.lift.map((l) => l * g),
      walk: {from, length: gone}, walkFrames: t.walk, stand: t.stand, look: t.look, hop: t.hop},
  };
}

export const fitsFor = (side: number, mirrored: boolean) => CARRIERS.map((c) => fit(c, side, mirrored));

/** A carried card's footprint: the card plus the furthest any ant reaches past it, so every carrier keeps the same place in line. */
export function carriedWidth(side: number): number {
  const f = fitsFor(side, false);
  return side + Math.max(...f.map((a) => a.behind)) + Math.max(...f.map((a) => a.beyond));
}

/** The room a lane needs under its cards for the lowest feet. */
export const laneBelow = (side: number) => Math.max(...fitsFor(side, false).map((a) => a.below));

// a fixed hash per lane and place, so the cast and stride phases are the same on every load
function hash(k: number, i: number): number {
  let t = Math.imul((k + 1) * 7919 + i * 104729, 2654435761) >>> 0;
  t ^= t >>> 15; t = Math.imul(t, 2246822507) >>> 0; t ^= t >>> 13;
  return t / 4294967296;
}
export const unitHash = (k: number, i: number) => ((hash(k, i) * 4294967296) >>> 0) / 4294967296;
export const walksAhead = (lane: number, i: number) => hash(lane, i) < SHARE_AHEAD;

/** Which carrier hauls each of `n` cards of lane `k`: never the same as either neighbour (a loop), and where possible not the one two
 *  places back nor the one in the lane above at the same place. */
export function castLane(k: number, n: number, above: number[] | null): number[] {
  const all = CARRIERS.map((_, j) => j);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const near = [out[i - 1], i === n - 1 ? out[0] : undefined].filter((j) => j !== undefined);
    const far = [out[i - 2], i >= n - 2 ? out[(i + 2) % n] : undefined, above?.[i]].filter((j) => j !== undefined);
    let can = all.filter((j) => !near.includes(j) && !far.includes(j));
    if (!can.length) can = all.filter((j) => !near.includes(j));
    out.push(can[Math.floor(unitHash(k + 4, i) * can.length)]);
  }
  return out;
}
