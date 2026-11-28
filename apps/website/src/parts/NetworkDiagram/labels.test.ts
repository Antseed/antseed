import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fitLabels, type Labels} from './labels.ts';

/** One label stack of one item, its edges in drawing units, recording the transform fitLabels gives it. */
function stack(l: number, r: number, side: 'l' | 'r', cube = false) {
  const el = {transform: '', setAttribute(_: string, v: string) { this.transform = v; }, removeAttribute() { this.transform = ''; }};
  const item = {el, l, r, t: 900, b: 916, sx: 0, sy: 0};
  return {el, st: {items: [item], side, ax: side === 'l' ? l : r, ay: 908, dx: 0, cube}};
}
const labels = (stacks: ReturnType<typeof stack>['st'][]) => ({stacks, names: [], view: {l: -12, r: 1260}, reset() {}}) as unknown as Labels;
const SMALL = 0.5;   // screen px per drawing unit on a narrow stage: labels grow by 11 / 6.5, about 1.69×

/** The scale a transform gives, 1 when it has none. */
const scaleOf = (transform: string) => Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? 1);

test('a stack growing leftwards past the drawing edge grows less, keeping its anchor, and stays inside the view', () => {
  const holders = stack(-4, 36, 'r', true);   // 'ANTS holders', anchored on its right edge by its cube
  fitLabels(labels([holders.st]), SMALL);
  const g = scaleOf(holders.el.transform);
  assert.equal(holders.st.dx, 0);
  assert.ok(g > 1 && g < 11 / (13 * SMALL), `grows, but less than the others (${g})`);
  const left = holders.st.ax + (-4 - holders.st.ax) * g;
  assert.ok(left >= -12 + 4 - 0.01, `left edge ${left} is inside the view`);
});

test('a stack well inside the drawing keeps its place, and refitting does not drift', () => {
  const inside = stack(400, 460, 'l');
  const holders = stack(-4, 36, 'r', true);
  const ls = labels([inside.st, holders.st]);
  fitLabels(ls, SMALL);
  const first = holders.st.dx;
  fitLabels(ls, SMALL);
  assert.equal(inside.st.dx, 0);
  assert.equal(scaleOf(inside.el.transform).toFixed(3), (11 / (13 * SMALL)).toFixed(3));
  assert.equal(holders.st.dx, first);
});
