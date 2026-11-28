/* The privacy band's dot mosaic: a 1504 × 832 SVG of round dots on a 15.45px grid, dense round the edges. One file per theme, fetched
   once per page (the other only when the theme changes) and laid out to fit any band size. */

export const STEP = 15.45;
export const DOT_RADIUS = 2.4;
const MOSAIC_W = 1504;
const MOSAIC_H = 832;
/** At least this much of the mosaic's top and bottom edge stays, however short the band. */
const MIN_BAND = 160;
/** A band taller than the mosaic repeats this block of side rows down its middle, so the frame stays whole. */
const SIDE_TOP = 160;
const SIDE_BOTTOM = 672;
const SIDE = 30 * STEP;

export type Box = {l: number; r: number; t: number; b: number};
export type DotGroup = {fill: string; dots: [number, number][]};
/** The dots laid in a band, per colour, plus every dot's centre (for the moving layer). */
export type Layout = {paths: {fill: string; path: Path2D}[]; xs: number[]; ys: number[]};

const cache = new Map<string, Promise<DotGroup[]>>();

export function loadMosaic(night: boolean): Promise<DotGroup[]> {
  const url = `/site/assets/home/${night ? 'privacy-dots-dark.svg' : 'privacy-dots.svg'}`;
  let p = cache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${url}: ${r.status}`))))
      .then(parse);
    p.catch(() => cache.delete(url));   // a failed fetch is retried by the next caller
    cache.set(url, p);
  }
  return p;
}

function parse(svg: string): DotGroup[] {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  return [...doc.querySelectorAll('g')].map((g) => ({
    fill: g.getAttribute('fill') ?? '#000',
    dots: [...g.querySelectorAll('circle')].map((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]),
  }));
}

/** The mosaic's top half from the band's top, its bottom half from the band's bottom, centred horizontally; no dot inside a `clear` box. */
export function layOut(groups: DotGroup[], width: number, height: number, clear: Box[] = []): Layout {
  const band = Math.max(MIN_BAND, MOSAIC_H - height / 2);
  const ox = width / 2 - MOSAIC_W / 2;
  const xs: number[] = [];
  const ys: number[] = [];
  const paths = groups.map((g) => {
    const path = new Path2D();
    const add = (x: number, y: number) => {
      if (x < -DOT_RADIUS || y < -DOT_RADIUS || x > width + DOT_RADIUS || y > height + DOT_RADIUS) return;
      if (clear.some((c) => x > c.l && x < c.r && y > c.t && y < c.b)) return;
      path.moveTo(x + DOT_RADIUS, y);
      path.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
      xs.push(x);
      ys.push(y);
    };
    for (const [cx, cy] of g.dots) {
      const x = ox + cx;
      if (cy < band) add(x, cy);
      if (MOSAIC_H - cy < band) add(x, height - (MOSAIC_H - cy));
      if (cy >= SIDE_TOP && cy < SIDE_TOP + SIDE) for (let y = cy; y < height / 2; y += SIDE) if (y >= band) add(x, y);
      if (cy >= SIDE_BOTTOM - SIDE && cy < SIDE_BOTTOM) {
        for (let y = height - (MOSAIC_H - cy); y >= height / 2; y -= SIDE) if (y < height - band) add(x, y);
      }
    }
    return {fill: g.fill, path};
  });
  return {paths, xs, ys};
}
