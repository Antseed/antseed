// The 1200×630 share image for a profile, drawn on a canvas so people can
// save it and attach it to a post. Colours and the Node-head ant match the site.
export interface ShareCardData {
  handle: string;
  name: string;
  avatar?: string;
  epoch: number;
  points: number;
  ants: number;
  rank: { rank: number; of: number } | null;
}

const C = { ink: '#001E12', mint: '#C6F0E2', mint2: '#E2FFF0', green: '#10B981', forest: '#0A6F4D', seed: '#F2C46D', slate: '#3B5249', white: '#FFFFFF' };
const DISPLAY = '"General Sans", "Geist", system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, Menlo, monospace';
const n0 = (n: number) => Math.round(n).toLocaleString('en-US');

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // Without CORS the canvas would be tainted and couldn't be saved, so a failed load just drops the avatar.
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, text: string, font: string, bg: string, fg: string, padX = 22) {
  ctx.font = font;
  const w = ctx.measureText(text).width + padX * 2;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + h / 2 + 1);
  return w;
}

/** The Node-head ant from components/Ant.tsx, in its 200×200 box. */
function ant(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 200, size / 200);
  ctx.strokeStyle = C.green;
  ctx.fillStyle = C.green;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  for (const [x1, y1, x2, y2, cx, cy] of [[78, 72, 52, 34, 50, 31], [122, 72, 148, 34, 150, 31]] as const) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(100, 118, 60, 56, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.ink;
  for (const ex of [80, 120]) {
    ctx.beginPath();
    ctx.ellipse(ex, 112, 9, 15, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export async function drawShareCard(canvas: HTMLCanvasElement, d: ShareCardData): Promise<void> {
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d')!;
  await document.fonts?.ready;

  ctx.fillStyle = C.mint;
  ctx.fillRect(0, 0, 1200, 630);
  // A soft light-mint field behind the ant, like the site's colour fields.
  ctx.fillStyle = C.mint2;
  ctx.beginPath();
  ctx.arc(1010, 470, 300, 0, Math.PI * 2);
  ctx.fill();
  ant(ctx, 790, 250, 420);

  // Badge
  pill(ctx, 64, 56, 44, 'ANTSEED POINTS', `600 18px ${MONO}`, C.ink, C.seed);

  // Who
  const avatar = d.avatar ? await loadImage(d.avatar) : null;
  let tx = 64;
  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(64 + 40, 170, 40, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, 64, 130, 80, 80);
    ctx.restore();
    tx = 64 + 80 + 20;
  }
  ctx.fillStyle = C.ink;
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 38px ${DISPLAY}`;
  ctx.fillText(d.name || `@${d.handle}`, tx, 166, 640 - tx);
  ctx.fillStyle = C.slate;
  ctx.font = `500 24px ${DISPLAY}`;
  ctx.fillText(`@${d.handle}`, tx, 200);

  // The number
  ctx.fillStyle = C.forest;
  ctx.font = `600 164px ${DISPLAY}`;
  ctx.fillText(n0(d.points), 58, 398, 760);
  ctx.fillStyle = C.ink;
  ctx.font = `600 34px ${DISPLAY}`;
  ctx.fillText('points this week', 64, 450);

  // Facts
  let px = 64;
  px += pill(ctx, px, 492, 56, `≈ ${n0(d.ants)} ANTS est. this week`, `600 24px ${DISPLAY}`, C.white, C.ink) + 12;
  if (d.rank) pill(ctx, px, 492, 56, `#${n0(d.rank.rank)} of ${n0(d.rank.of)} buyers`, `600 24px ${DISPLAY}`, C.ink, C.white);

  ctx.fillStyle = C.slate;
  ctx.font = `500 20px ${DISPLAY}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('The AI network that rewards you for using it', 64, 596);
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), 'image/png');
    } catch {
      resolve(null);
    }
  });
}
