import {DOT_RADIUS, type DotGroup, type Layout} from './mosaic';

/** The mosaic's size in its own cells. */
const MOSAIC_COLS = 97;
const MOSAIC_ROWS = 54;
/** The mosaic's own grid: first dot centre and pitch, to find each dot's cell. */
const MOSAIC_X0 = 7.2;
const MOSAIC_Y0 = 6.5;
const MOSAIC_STEP = 15.45;

/** Target cell k of n → source cell in a mosaic m cells long: the first half from its start, the rest from its end; a box larger than
 *  the mosaic repeats its inner cells in the middle, so the frame stays whole at any size. */
function sourceCell(k: number, n: number, m: number): number {
  const half = Math.floor(m / 2);
  if (n <= m) return k < Math.ceil(n / 2) ? k : m - (n - k);
  if (k < half) return k;
  if (n - k <= m - half) return m - (n - k);
  const q = Math.floor(m / 4);
  return q + ((k - half) % (m - 2 * q));
}

/** The mosaic laid cell for cell on a `step` grid filling the box edge to edge, centred so the outer dots sit half a step in. */
export function layOutGrid(groups: DotGroup[], width: number, height: number, step: number): Layout {
  const cols = Math.floor(width / step);
  const rows = Math.floor(height / step);
  const ox = (width - cols * step) / 2 + step / 2;
  const oy = (height - rows * step) / 2 + step / 2;
  const groupAt = new Map<string, number>();
  groups.forEach((g, gi) => {
    for (const [x, y] of g.dots) groupAt.set(`${Math.round((x - MOSAIC_X0) / MOSAIC_STEP)},${Math.round((y - MOSAIC_Y0) / MOSAIC_STEP)}`, gi);
  });
  const paths = groups.map((g) => ({fill: g.fill, path: new Path2D()}));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const gi = groupAt.get(`${sourceCell(i, cols, MOSAIC_COLS)},${sourceCell(j, rows, MOSAIC_ROWS)}`);
    if (gi === undefined) continue;
    const x = ox + i * step;
    const y = oy + j * step;
    paths[gi].path.moveTo(x + DOT_RADIUS, y);
    paths[gi].path.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
    xs.push(x); ys.push(y);
  }
  return {paths, xs, ys};
}
