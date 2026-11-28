import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DOT, INSET, PITCH, centreX, centreY, fitGrid, grade, insideCard} from './meadow.ts';

test('the grid fills the card, inset from its edge, with the outer dots the same distance from every edge', () => {
  for (const [w, h] of [[1200, 440], [336, 368], [328, 392], [1264, 488]]) {
    const g = fitGrid(w, h);
    assert.ok(Math.abs(g.px - PITCH) < 0.5 && Math.abs(g.py - PITCH) < 0.5, `${w}x${h}: pitch ${g.px} × ${g.py}`);
    const left = centreX(g, 0) - DOT / 2;
    const right = w - (centreX(g, g.cols - 1) + DOT / 2);
    const top = centreY(g, 0) - DOT / 2;
    const bottom = h - (centreY(g, g.rows - 1) + DOT / 2);
    assert.ok(left >= INSET, `${w}x${h}: the outer dots ${left}px from the edge`);
    for (const m of [right, top, bottom]) assert.ok(Math.abs(m - left) < 0.6, `${w}x${h}: margins ${left} ${right} ${top} ${bottom}`);
  }
});

test('a dot the rounded corner would cut is left out', () => {
  const g = fitGrid(1200, 440);
  assert.equal(insideCard(g, 0, 0, 40), false);
  assert.equal(insideCard(g, 1, 1, 40), true);
  assert.equal(insideCard(g, 5, 0, 40), true);
});

/** One pixel per dot, all paper, with one leaf green at (1, 1) and one at the centre. */
function plate(cols: number, rows: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(cols * rows * 4).fill(246);
  const leaf = (i: number, j: number) => px.set([120, 150, 90, 255], (j * cols + i) * 4);
  leaf(1, 1);
  leaf(Math.floor(cols / 2), Math.floor(rows / 2));
  return px;
}

test('the paper drops out, the leaves stay, and the glow clears the dots behind the words', () => {
  const g = fitGrid(310, 155);
  const mid = Math.floor(g.rows / 2) * g.cols + Math.floor(g.cols / 2);
  const glow = {x: centreX(g, Math.floor(g.cols / 2)), y: centreY(g, Math.floor(g.rows / 2)), rx: 60, ry: 30, strength: 0.9, soft: 0.65};
  for (const night of [false, true]) {
    const t = grade(plate(g.cols, g.rows), g, glow, night, 0);
    assert.equal(t.alpha[3 * g.cols + 5], 0, 'paper');
    assert.ok(t.alpha[g.cols + 1] > 0.4, 'a leaf outside the glow');
    if (!night) assert.ok(t.alpha[g.cols + 1] < 0.6, 'by day, a tint rather than a picture');
    assert.ok(t.alpha[mid] < 0.15, 'a leaf behind the words');
    if (night) assert.ok(t.lit[g.cols + 1] > 0.3 && t.lit[g.cols + 1] <= 0.75, 'a green leaf lights up softly at night');
  }
});

test('no dot within the clear margin of a line of text or the button', () => {
  const g = fitGrid(336, 368);
  const px = new Uint8ClampedArray(g.cols * g.rows * 4);
  for (let q = 0; q < g.cols * g.rows; q++) px.set([120, 150, 90, 255], q * 4);   // all leaves
  const rects = [{l: 40, t: 100, r: 296, b: 136}, {l: 110, t: 240, r: 226, b: 288}];
  // the ellipse alone (as on a phone) is smaller than the words; the boxes clear them anyway
  const glow = {x: 168, y: 190, rx: 100, ry: 80, strength: 0.9, soft: 0.5, rects};
  for (const night of [false, true]) {
    const t = grade(px, g, glow, night, 20);
    for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) {
      const x = centreX(g, i), y = centreY(g, j);
      const d = Math.min(...rects.map((r) => Math.hypot(Math.max(r.l - x, 0, x - r.r), Math.max(r.t - y, 0, y - r.b)))) - DOT / 2;
      if (d < 12) assert.ok(t.alpha[j * g.cols + i] <= 0.01, `dot ${i},${j} ${d.toFixed(1)}px from the words: ${t.alpha[j * g.cols + i]}`);
    }
    assert.ok(t.alpha[2 * g.cols + 2] > 0.4, 'the frame stays live');
  }
});
