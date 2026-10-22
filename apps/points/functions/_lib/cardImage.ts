// The 1200×630 share card as a PNG, rendered on the server for link previews.
// It is the same layout as the canvas in src/lib/shareCard.ts (same colours,
// positions and Node-head ant), built for satori, then rasterised by resvg.
// Satori stays on 0.32: later versions add a HarfBuzz shaper that compiles
// WebAssembly at runtime. Both run as precompiled WebAssembly, the only kind Workers allow.
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import satori, { init as initSatori, type Font } from 'satori/standalone';
import yogaWasm from 'satori/yoga.wasm';
import type { CardData } from './card';

const C = { ink: '#001E12', mint: '#C6F0E2', mint2: '#E2FFF0', green: '#10B981', forest: '#0A6F4D', seed: '#F2C46D', slate: '#3B5249', white: '#FFFFFF' };
const n0 = (n: number) => Math.round(n).toLocaleString('en-US');

let wasmReady: Promise<unknown> | null = null;
const ready = () => (wasmReady ??= Promise.all([initSatori(yogaWasm), initWasm(resvgWasm)]).catch((e) => {
  wasmReady = null;
  throw e;
}));

// ── Fonts ────────────────────────────────────────────────────────────────────
// General Sans is fetched from Fontshare at runtime: its licence doesn't allow
// committing the files to this public repo. Geist (free) stands in if Fontshare
// is down; Geist Mono is the badge font, as on the site.
const FONTSHARE_CSS = 'https://api.fontshare.com/v2/css?f[]=general-sans@500,600';
const FONTSOURCE = 'https://cdn.jsdelivr.net/fontsource/fonts';

async function bytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { cf: { cacheTtl: 86_400, cacheEverything: true }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.arrayBuffer();
}

async function generalSans(): Promise<Font[]> {
  const css = await (await fetch(FONTSHARE_CSS, { cf: { cacheTtl: 86_400, cacheEverything: true }, signal: AbortSignal.timeout(5000) })).text();
  const faces = css.split('@font-face').slice(1).map((block) => ({
    weight: Number(/font-weight:\s*(\d+)/.exec(block)?.[1]),
    // Satori reads TTF, OTF and WOFF, not WOFF2.
    url: /url\('([^']+\.ttf)'\)/.exec(block)?.[1],
  }));
  return Promise.all(
    ([500, 600] as const).map(async (weight) => {
      const url = faces.find((f) => f.weight === weight)?.url;
      if (!url) throw new Error(`Fontshare has no General Sans ${weight}`);
      return { name: 'Display', weight, style: 'normal' as const, data: await bytes(url.startsWith('//') ? `https:${url}` : url) };
    }),
  );
}

const geist = () =>
  Promise.all(([500, 600] as const).map(async (weight) => ({ name: 'Display', weight, style: 'normal' as const, data: await bytes(`${FONTSOURCE}/geist-sans@latest/latin-${weight}-normal.woff`) })));

let fontsReady: Promise<Font[]> | null = null;
const fonts = () => (fontsReady ??= Promise.all([
  generalSans().catch(geist),
  bytes(`${FONTSOURCE}/geist-mono@latest/latin-600-normal.woff`).then((data): Font => ({ name: 'Mono', weight: 600, style: 'normal', data })),
]).then(([display, mono]) => [...display, mono]).catch((e) => {
  fontsReady = null;
  throw e;
}));

// ── Avatar ───────────────────────────────────────────────────────────────────
async function avatarDataUri(src: string | undefined): Promise<string | null> {
  if (!src) return null;
  try {
    const url = new URL(src);
    // Avatars come from X sign-in; never fetch anything else on a crawler's behalf.
    if (url.protocol !== 'https:' || !/(^|\.)twimg\.com$/.test(url.hostname)) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !/^image\/(png|jpeg)/.test(type)) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return `data:${type.split(';')[0]};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

// ── Layout ───────────────────────────────────────────────────────────────────
type Style = Record<string, string | number>;
interface Node {
  type: string;
  props: Record<string, unknown>;
}
const h = (type: string, props: Record<string, unknown>, ...children: (Node | string | null)[]): Node => ({
  type,
  props: { ...props, children: children.filter((c) => c !== null) },
});
const box = (style: Style, ...children: (Node | string | null)[]) => h('div', { style: { display: 'flex', ...style } }, ...children);

// The canvas draws text from a baseline; satori places boxes by their top. With
// line-height 1, the baseline sits this far below the top of the box.
const BASELINE = 0.88;
const text = (x: number, baseline: number, size: number, style: Style, s: string) =>
  box({ position: 'absolute', left: x, top: baseline - size * BASELINE, fontSize: size, lineHeight: 1, whiteSpace: 'nowrap', ...style }, s);

const pill = (h: number, size: number, bg: string, fg: string, family: string, s: string, padX = 22) =>
  box({ height: h, padding: `0 ${padX}px`, borderRadius: h / 2, background: bg, color: fg, fontFamily: family, fontSize: size, fontWeight: 600, alignItems: 'center' }, s);

/** The Node-head ant from components/Ant.tsx. */
const ant = (x: number, y: number, size: number) =>
  h(
    'svg',
    { viewBox: '0 0 200 200', width: size, height: size, style: { position: 'absolute', left: x, top: y } },
    h('path', { d: 'M78 72 L52 34', stroke: C.green, strokeWidth: 7, strokeLinecap: 'round' }),
    h('circle', { cx: 50, cy: 31, r: 11, fill: C.green }),
    h('path', { d: 'M122 72 L148 34', stroke: C.green, strokeWidth: 7, strokeLinecap: 'round' }),
    h('circle', { cx: 150, cy: 31, r: 11, fill: C.green }),
    h('ellipse', { cx: 100, cy: 118, rx: 60, ry: 56, fill: C.green }),
    h('ellipse', { cx: 80, cy: 112, rx: 9, ry: 15, fill: C.ink }),
    h('ellipse', { cx: 120, cy: 112, rx: 9, ry: 15, fill: C.ink }),
  );

function card(d: CardData, avatar: string | null): Node {
  const tx = avatar ? 64 + 80 + 20 : 64;
  const points = n0(d.points);
  // The canvas squeezes the number into 760px; shrink it instead so very large totals still fit.
  const bigSize = Math.min(164, Math.floor(760 / (points.length * 0.62)));
  return box(
    { position: 'relative', width: 1200, height: 630, background: C.mint, overflow: 'hidden', fontFamily: 'Display', fontWeight: 600, color: C.ink },
    box({ position: 'absolute', left: 1010 - 300, top: 470 - 300, width: 600, height: 600, borderRadius: 300, background: C.mint2 }),
    ant(790, 250, 420),
    box({ position: 'absolute', left: 64, top: 56 }, pill(44, 18, C.ink, C.seed, 'Mono', 'ANTSEED POINTS')),
    avatar ? h('img', { src: avatar, width: 80, height: 80, style: { position: 'absolute', left: 64, top: 130, borderRadius: 40 } }) : null,
    text(tx, 166, 38, { maxWidth: 640 - tx, overflow: 'hidden', textOverflow: 'ellipsis', paddingBottom: 6 }, d.name || `@${d.handle}`),
    text(tx, 200, 24, { color: C.slate, fontWeight: 500 }, `@${d.handle}`),
    text(58, 398, bigSize, { color: C.forest, letterSpacing: -1 }, points),
    text(64, 450, 34, {}, `points in epoch ${d.epoch}`),
    box(
      { position: 'absolute', left: 64, top: 492, gap: 12 },
      d.ants === null ? null : pill(56, 24, C.white, C.ink, 'Display', `≈ ${n0(d.ants)} ANTS so far`),
      d.rank ? pill(56, 24, C.ink, C.white, 'Display', `#${n0(d.rank.rank)} of ${n0(d.rank.of)} buyers`) : null,
    ),
    text(64, 596, 20, { color: C.slate, fontWeight: 500 }, 'The AI network that rewards you for using it'),
  );
}

export async function renderCardPng(d: CardData): Promise<Uint8Array> {
  const [, fontList, avatar] = await Promise.all([ready(), fonts(), avatarDataUri(d.avatar)]);
  const svg = await satori(card(d, avatar) as unknown as Parameters<typeof satori>[0], { width: 1200, height: 630, fonts: fontList });
  return new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
}
