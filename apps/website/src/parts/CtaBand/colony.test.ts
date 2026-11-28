import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Colony} from './colony.ts';
import {centreX, centreY, fitGrid} from './meadow.ts';

/** A phone's card: the words' glow (veil 0) fills the middle, the dots show only in a frame two cells deep. */
function phone() {
  const g = fitGrid(336, 368);
  const veil = new Float32Array(g.cols * g.rows);
  for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) {
    const edge = Math.min(i, j, g.cols - 1 - i, g.rows - 1 - j);
    veil[j * g.cols + i] = edge < 2 ? 1 : 0;
  }
  const c = new Colony();
  c.reset(g, veil, new Uint8Array(g.cols * g.rows).fill(1));
  return {c, g};
}

test('a tap behind the words calls every ant to the nearest cell where they show, beside the tap', () => {
  const {c, g} = phone();
  const x = 168, y = 260;   // under the sub line, inside the glow
  c.call(x, y, 0);
  const goals = new Set(c.ants.map((a) => `${a.goal}`));
  assert.equal(goals.size, 1);
  assert.ok(c.ants.every((a) => a.state === 'called'));
  const [gi, gj] = c.ants[0].goal!;
  const edge = Math.min(gi, gj, g.cols - 1 - gi, g.rows - 1 - gj);
  assert.ok(edge < 2, 'the goal is in the visible frame');
  assert.ok(Math.hypot(centreX(g, gi) - x, centreY(g, gj) - y) < 124, 'and near the tap');
});

test('called ants come to the call', () => {
  const {c} = phone();
  c.call(20, 340, 0);
  const goal = c.ants[0].goal!;
  const dist = () => c.ants.reduce((s, a) => s + Math.abs(a.i - goal[0]) + Math.abs(a.j - goal[1]), 0);
  const before = dist();
  for (let t = 16; t < 3000; t += 16) c.tick(t);
  assert.ok(dist() < before / 3, `${before} → ${dist()}`);
});

test('on a touch screen, a few ants fall into a file of their own now and then', () => {
  const {c} = phone();
  c.auto = true;
  let longest = 0;
  for (let t = 16; t < 30000; t += 16) { c.tick(t); longest = Math.max(longest, c.queue.length); }
  assert.ok(longest >= 2, `longest file ${longest}`);
});
