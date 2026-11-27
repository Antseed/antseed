import {useEffect, useRef, useState, type JSX, type RefObject} from 'react';
import {canvasDpr} from '../../lib/ledGrid';
import {useFrameLoop} from '../../lib/useFrameLoop';
import {useInView} from '../../lib/useInView';
import {usePageVisible} from '../../lib/usePageVisible';
import {useSiteTheme} from '../../lib/useSiteTheme';
import {useStill} from '../../lib/useStill';
import {bindPointerAndCalls} from '../PrivacyDots/usePointerAndCalls';
import {Colony, DAY, NIGHT} from './colony';
import {DOT, centreX, centreY, fitGrid, grade, type Glow, type Grid, type Rect, type Tiles} from './meadow';
import styles from './CtaDots.module.css';

const LOAD_MARGIN = '400px 0px';
/** The watercolours, a few hundred px wide: they are sampled one pixel per dot. The tall one on a card taller than wide. */
const MEADOWS = {wide: '/site/assets/cta/meadow-wide.webp', tall: '/site/assets/cta/meadow-tall.webp'} as const;
type Shape = keyof typeof MEADOWS;
/** The glow round the words, in multiples of their block: on a phone, where the words fill the card, held close to them. */
const GLOW = {strength: 0.9, width: 1.2, height: 1.45, soft: 0.65};
const GLOW_PHONE = {strength: 0.9, width: 0.85, height: 0.95, soft: 0.5};
/** Night: how strongly the lit dots glow, and how far (px): a breath, so the button stays the brightest mark. */
const LIT_GLOW = 0.22;
const LIT_BLUR = 4;

const images = new Map<string, Promise<HTMLImageElement>>();
function loadImage(src: string): Promise<HTMLImageElement> {
  let p = images.get(src);
  if (!p) {
    p = new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error(src)); i.src = src; });
    p.catch(() => images.delete(src));   // a failed load is tried again next time
    images.set(src, p);
  }
  return p;
}

function glowOf(host: HTMLElement, content: HTMLElement | null): Glow | null {
  if (!content) return null;
  const b = host.getBoundingClientRect();
  const c = content.getBoundingClientRect();
  const k = window.matchMedia('(max-width: 760px)').matches ? GLOW_PHONE : GLOW;
  // the words' own boxes: each line of the title and the sub, and the links (the button), in card px
  const rects: Rect[] = [];
  const add = (r: DOMRect) => { if (r.width && r.height) rects.push({l: r.left - b.left, t: r.top - b.top, r: r.right - b.left, b: r.bottom - b.top}); };
  const range = document.createRange();
  for (const el of content.querySelectorAll('h2, p')) { range.selectNodeContents(el); for (const r of range.getClientRects()) add(r); }
  for (const el of content.querySelectorAll('a, button')) add(el.getBoundingClientRect());
  return {x: c.left - b.left + c.width / 2, y: c.top - b.top + c.height / 2, rx: (c.width / 2) * k.width, ry: (c.height / 2) * k.height, strength: k.strength, soft: k.soft, rects};
}

/** The meadow at rest, drawn once per size and theme; at night the lit dots' glow is added over it. */
function paintMeadow(ctx: CanvasRenderingContext2D, g: Grid, t: Tiles, dpr: number, night: boolean): void {
  // k scales card px to the canvas's own px, for a context drawn untransformed
  const tile = (c: CanvasRenderingContext2D, q: number, dx = 0, k = 1) => {
    c.beginPath(); c.arc(centreX(g, q % g.cols) * k - dx, centreY(g, Math.floor(q / g.cols)) * k, (DOT / 2) * k, 0, Math.PI * 2); c.fill();
  };
  const colour = (q: number) => `rgb(${t.rgb[q * 3] | 0},${t.rgb[q * 3 + 1] | 0},${t.rgb[q * 3 + 2] | 0})`;
  for (let q = 0; q < t.alpha.length; q++) if (t.alpha[q]) { ctx.globalAlpha = t.alpha[q]; ctx.fillStyle = colour(q); tile(ctx, q); }
  ctx.globalAlpha = 1;
  if (!night || !LIT_GLOW) return;
  // the glow: only the lit dots' blurred shadows (each dot drawn far off to the left, its shadow cast back in place), added on.
  // Drawn untransformed, in the canvas's own px, as a shadow's offset and blur are: one unit for the dots, the offset and the blur
  const glow = document.createElement('canvas');
  glow.width = ctx.canvas.width; glow.height = ctx.canvas.height;
  const gc = glow.getContext('2d');
  if (!gc) return;
  const off = glow.width + 100 * dpr;
  gc.shadowOffsetX = off;
  gc.shadowBlur = LIT_BLUR * 2 * dpr;
  for (let q = 0; q < t.lit.length; q++) if (t.lit[q] > 0.04) { gc.globalAlpha = t.lit[q]; gc.shadowColor = colour(q); tile(gc, q, off, dpr); }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = LIT_GLOW;
  ctx.drawImage(glow, 0, 0);
  ctx.restore();
}

type Props = {contentRef: RefObject<HTMLElement | null>};

/** The Meadow hero's dot mosaic filling its positioned parent (the card), with its ants. The watercolour is fetched once the card nears;
 *  the ants move only while it is on screen, with the tab visible and motion allowed. */
export default function CtaDots({contentRef}: Props): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const stillCanvas = useRef<HTMLCanvasElement>(null);
  const liveCanvas = useRef<HTMLCanvasElement>(null);
  const colony = useRef<Colony | null>(null);
  const night = useSiteTheme() === 'dark';
  const still = useStill();
  const visible = usePageVisible();
  const near = useInView(host, {rootMargin: LOAD_MARGIN, once: true});
  const onScreen = useInView(host);
  const [shape, setShape] = useState<Shape | null>(null);
  const [meadow, setMeadow] = useState<{shape: Shape; img: HTMLImageElement} | null>(null);
  const [ready, setReady] = useState(false);
  const look = night ? NIGHT : DAY;
  const lookRef = useRef(look);
  lookRef.current = look;

  useEffect(() => {
    if (!near || !shape) return;
    let live = true;
    loadImage(MEADOWS[shape]).then((img) => { if (live) setMeadow({shape, img}); }, (err: unknown) => console.warn('cta meadow not drawn', err));
    return () => { live = false; };
  }, [near, shape]);

  useEffect(() => {
    const el = host.current;
    const bgCanvas = stillCanvas.current;
    const fgCanvas = liveCanvas.current;
    const bg = bgCanvas?.getContext('2d');
    const fg = fgCanvas?.getContext('2d');
    if (!el || !bgCanvas || !fgCanvas || !bg || !fg) return;
    const ants = (colony.current ??= new Colony());
    ants.auto = window.matchMedia('(hover: none)').matches;
    const sample = document.createElement('canvas');
    const draw = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const want: Shape = h > w ? 'tall' : 'wide';
      setShape(want);
      if (meadow?.shape !== want) return;
      const g = fitGrid(w, h);
      sample.width = g.cols; sample.height = g.rows;
      const sc = sample.getContext('2d', {willReadFrequently: true});
      if (!sc) return;
      sc.imageSmoothingQuality = 'high';
      sc.drawImage(meadow.img, 0, 0, g.cols, g.rows);   // stretched to the card, so the meadow frames it at any shape
      const radius = parseFloat(getComputedStyle(el.parentElement ?? el).borderTopLeftRadius) || 0;
      const tiles = grade(sc.getImageData(0, 0, g.cols, g.rows).data, g, glowOf(el, contentRef.current), night, radius);
      const dpr = canvasDpr();
      for (const c of [bgCanvas, fgCanvas]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = `${w}px`; c.style.height = `${h}px`; }
      bg.setTransform(dpr, 0, 0, dpr, 0, 0);
      fg.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintMeadow(bg, g, tiles, dpr, night);
      ants.reset(g, tiles.veil, tiles.on);
      ants.draw(fg, performance.now(), lookRef.current);   // still: this one frame, the ants where they start
      setReady(true);
    };
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => { ro.disconnect(); bg.clearRect(0, 0, bgCanvas.width, bgCanvas.height); fg.clearRect(0, 0, fgCanvas.width, fgCanvas.height); };
  }, [meadow, night, contentRef]);

  // a mouse over the card leads the ants; a click or tap on its background (not a link or the words) calls them. Touch moves are
  // left to the page's scroll
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    return bindPointerAndCalls(el, {
      ignore: 'a, button, h2, p',
      move: (p, e) => { if (e.pointerType === 'mouse') colony.current?.setPointer(p, performance.now()); },
      leave: () => colony.current?.setPointer(null, performance.now()),
      call: (p) => colony.current?.call(p.x, p.y, performance.now()),
    });
  }, []);

  useFrameLoop(ready && onScreen && visible && !still, (now) => {
    const ants = colony.current;
    const fg = liveCanvas.current?.getContext('2d');
    if (ants && fg && ants.tick(now)) ants.draw(fg, now, lookRef.current);
  });

  return (
    <div ref={host} className={styles.host} aria-hidden="true">
      <canvas ref={stillCanvas} className={styles.canvas} />
      <canvas ref={liveCanvas} className={styles.canvas} />
    </div>
  );
}
