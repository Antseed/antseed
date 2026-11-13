/**
 * Antseed network globe: a rotating sphere of peers where requests arc in from
 * anywhere on the network and land on providers, which pulse when they're hit.
 *
 * Framework-free and deterministic: `draw(ctx, t)` renders the globe at any
 * time t (seconds). The whole thing repeats exactly every `loopSeconds`
 * (one full rotation, arcs included), so it loops seamlessly as a live canvas
 * or as a rendered video.
 *
 * Origin: the "open market" globe from the Antseed promo video.
 */

export type GlobeTheme = 'dark' | 'light';

export interface GlobeOptions {
  /** One full rotation, and the length of the repeating loop. Default 15s. */
  loopSeconds?: number;
  /** Requests per second landing on providers. Default 16. */
  arcsPerSecond?: number;
  /** How long one request takes to travel, in seconds: [min, max]. Default [0.5, 0.75]. */
  arcSeconds?: [number, number];
  /** Background peer dots on the sphere. Default 1150. */
  peers?: number;
  /** Provider nodes (the green dots). Default 480. */
  providers?: number;
  /** Random seed: same seed, same globe. Default 77. */
  seed?: number;
}

export interface GlobeBox {
  /** Center of the globe in canvas units (CSS px if you pre-scale for DPR). */
  cx: number;
  cy: number;
  /** Side of the square the globe (including the arcs that lift off it) fits in. */
  size: number;
}

export interface DrawOptions {
  theme?: GlobeTheme;
  /** Soft glow on the green parts (dark theme only). Default true. */
  glow?: boolean;
  /** 0..1 overall fade, e.g. for a fade-in. Default 1. */
  alpha?: number;
}

export interface Globe {
  draw(ctx: CanvasRenderingContext2D, t: number, box: GlobeBox, opts?: DrawOptions): void;
  readonly loopSeconds: number;
}

type V3 = [number, number, number];

const GREEN = '16,185,129'; // #10B981
const PALETTE = {
  dark: {peer: '245,247,245', peerAlpha: [0.12, 0.26, 0.5], arc: GREEN, arcAlpha: 0.8, head: '245,247,245', ring: GREEN},
  light: {peer: '0,30,18', peerAlpha: [0.1, 0.2, 0.4], arc: GREEN, arcAlpha: 0.85, head: '0,30,18', ring: GREEN},
};

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fib = (n: number, i: number): V3 => {
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(1 - y * y);
  const th = i * 2.399963;
  return [Math.cos(th) * r, y, Math.sin(th) * r];
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const inOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Radius of the sphere relative to the box: leaves room for arcs lifting 28% off the surface. */
const R_OF_SIZE = 0.5 / 1.32;
/** Pixel sizes below were tuned at this sphere radius (the promo video). */
const REF_R = 395;
const TILT = 0.36;
const ARC_LIFT = 0.28;
const ARC_FADE = 0.35;
const RING = 0.45;

export function createGlobe(options: GlobeOptions = {}): Globe {
  const L = options.loopSeconds ?? 15;
  const NP = options.peers ?? 1150;
  const NV = options.providers ?? 480;
  const rnd = mulberry32(options.seed ?? 77);

  const peers: V3[] = [];
  for (let i = 0; i < NP; i++) peers.push(fib(NP, i));

  // Providers sit on their own even spread; a few are much busier than the rest.
  const prov: {v: V3; q: number; w: number; hits: number[]}[] = [];
  for (let i = 0; i < NV; i++) {
    const q = rnd();
    prov.push({v: fib(NV, i), q, w: q ** 4 + 0.02, hits: []});
  }
  const totalW = prov.reduce((s, p) => s + p.w, 0);

  // Requests: evenly spread over the loop with jitter, each from a random peer to a weighted provider.
  const NA = Math.round((options.arcsPerSecond ?? 16) * L);
  const arcs: {a: V3; b: V3; ts: number; dur: number; om: number; so: number}[] = [];
  for (let k = 0; k < NA; k++) {
    const a = peers[Math.floor(rnd() * NP)];
    let r = rnd() * totalW;
    let pick = 0;
    for (let i = 0; i < NV; i++) {
      r -= prov[i].w;
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    const b = prov[pick].v;
    const ts = ((k + rnd()) / NA) * L;
    const [arcMin, arcMax] = options.arcSeconds ?? [0.5, 0.75];
    const dur = arcMin + rnd() * (arcMax - arcMin);
    const om = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    arcs.push({a, b, ts, dur, om, so: Math.sin(om) || 1e-6});
    prov[pick].hits.push(mod(ts + dur, L));
  }

  // Reused per frame.
  const peerBins = [0, 0, 0];

  function draw(ctx: CanvasRenderingContext2D, t: number, box: GlobeBox, opts: DrawOptions = {}) {
    const theme = opts.theme ?? 'dark';
    const pal = PALETTE[theme];
    const fade = opts.alpha ?? 1;
    if (fade <= 0) return;
    const R = box.size * R_OF_SIZE;
    const k = R / REF_R; // pixel scale vs the video
    const ry = 0.3 + (2 * Math.PI * mod(t, L)) / L;
    const cY = Math.cos(ry), sY = Math.sin(ry), cX = Math.cos(TILT), sX = Math.sin(TILT);

    // Project a point on (or lifted off) the unit sphere. Returns x, y, depth (-1 back .. 1 front), pixel scale for sizes.
    const proj = (x: number, y: number, z: number, out: number[]) => {
      const x1 = x * cY + z * sY, z1 = -x * sY + z * cY;
      const y1 = y * cX - z1 * sX, z2 = y * sX + z1 * cX;
      const persp = 2200 / (2200 - z2 * REF_R); // nearer = bigger
      out[0] = box.cx + x1 * R * persp;
      out[1] = box.cy + y1 * R * persp;
      out[2] = z2;
      out[3] = persp * k; // pixel scale for dot sizes
    };
    const P = [0, 0, 0, 0];

    ctx.save();
    ctx.globalAlpha = fade;

    // Peers, in three depth bands so the back of the sphere falls away.
    const bins = [new Path2D(), new Path2D(), new Path2D()];
    peerBins[0] = peerBins[1] = peerBins[2] = 0;
    for (const v of peers) {
      proj(v[0], v[1], v[2], P);
      const d = (P[2] + 1) / 2;
      const bi = d < 0.33 ? 0 : d < 0.66 ? 1 : 2;
      const r = 1.6 * P[3];
      bins[bi].moveTo(P[0] + r, P[1]);
      bins[bi].arc(P[0], P[1], r, 0, 2 * Math.PI);
    }
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = `rgba(${pal.peer},${pal.peerAlpha[i]})`;
      ctx.fill(bins[i]);
    }

    // Providers: size by how busy they are, pulse ring when a request lands.
    const pb = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    ctx.lineWidth = 1.8 * Math.max(k, 0.5);
    for (const p of prov) {
      proj(p.v[0], p.v[1], p.v[2], P);
      const d = (P[2] + 1) / 2;
      let since = Infinity;
      for (const h of p.hits) since = Math.min(since, mod(t - h, L));
      const bump = since < RING ? 1 + 0.35 * (1 - since / RING) : 1;
      const r = (2.6 + 7 * p.q ** 6) * P[3] * bump;
      const bi = Math.min(3, Math.floor(d * 4));
      pb[bi].moveTo(P[0] + r, P[1]);
      pb[bi].arc(P[0], P[1], r, 0, 2 * Math.PI);
      if (since < RING && d > 0.45) {
        const q = since / RING;
        ctx.strokeStyle = `rgba(${pal.ring},${(1 - q) * d})`;
        ctx.beginPath();
        ctx.arc(P[0], P[1], r + 18 * k * q, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = `rgba(${GREEN},${0.3 + 0.7 * ((i + 0.5) / 4)})`;
      ctx.fill(pb[i]);
    }

    // Requests arcing over the surface.
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.3 * Math.max(k, 0.5);
    const heads = new Path2D();
    const headR = 4.5 * Math.max(k, 0.5);
    for (const a of arcs) {
      const dt = mod(t - a.ts, L);
      if (dt > a.dur + ARC_FADE) continue;
      const p = inOutCubic(clamp01(dt / a.dur));
      if (p <= 0) continue;
      const f = 1 - clamp01((dt - a.dur) / ARC_FADE);
      const at = (s: number) => {
        const k1 = Math.sin((1 - s) * a.om) / a.so, k2 = Math.sin(s * a.om) / a.so, lift = 1 + ARC_LIFT * Math.sin(Math.PI * s);
        proj((a.a[0] * k1 + a.b[0] * k2) * lift, (a.a[1] * k1 + a.b[1] * k2) * lift, (a.a[2] * k1 + a.b[2] * k2) * lift, P);
      };
      const s0 = Math.max(0, p - 0.45);
      ctx.strokeStyle = `rgba(${pal.arc},${pal.arcAlpha * f})`;
      ctx.beginPath();
      for (let j = 0; j <= 16; j++) {
        at(s0 + ((p - s0) * j) / 16);
        if (j) ctx.lineTo(P[0], P[1]);
        else ctx.moveTo(P[0], P[1]);
      }
      ctx.stroke();
      if (p < 1) {
        at(p);
        heads.moveTo(P[0] + headR, P[1]);
        heads.arc(P[0], P[1], headR, 0, 2 * Math.PI);
      }
    }
    ctx.fillStyle = `rgb(${pal.head})`;
    ctx.fill(heads);
    ctx.restore();

    // Glow: a blurred, added copy of the globe's square (dark only; skipped where canvas filters aren't supported).
    if (theme === 'dark' && opts.glow !== false && 'filter' in ctx) {
      const tr = ctx.getTransform();
      const x0 = Math.max(0, Math.floor((box.cx - box.size / 2) * tr.a + tr.e));
      const y0 = Math.max(0, Math.floor((box.cy - box.size / 2) * tr.d + tr.f));
      const w = Math.min(ctx.canvas.width - x0, Math.ceil(box.size * tr.a));
      const h = Math.min(ctx.canvas.height - y0, Math.ceil(box.size * tr.d));
      if (w > 0 && h > 0) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.45 * fade;
        ctx.filter = `blur(${Math.max(2, 7 * k * tr.a)}px)`;
        ctx.drawImage(ctx.canvas, x0, y0, w, h, x0, y0, w, h);
        ctx.restore();
      }
    }
  }

  return {draw, loopSeconds: L};
}
