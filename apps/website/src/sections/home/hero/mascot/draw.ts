import type {Art, Picture} from './art';
import {RIG, TUNING} from './rig';

export type Pose = {body: Picture; irises: [number, number][]; open: number; lifts: number[]};

const SHUT = 0.25;        // share of the opening over which the painted line is painted out
const LIP = 4;            // the open mouth's outline, art px
const STEPS = 72;         // points round the mouth's outline

function drawArm(g: CanvasRenderingContext2D, art: Art, i: number, lift: number) {
  const {shoulder} = RIG.arms[i];
  g.save(); g.translate(shoulder[0], shoulder[1]); g.rotate(-lift * Math.PI / 180);
  g.drawImage(art.arms[i], -shoulder[0], -shoulder[1]);
  g.restore();
}

function drawPupils(g: CanvasRenderingContext2D, irises: [number, number][]) {
  const r = RIG.pupil;
  for (const [x, y] of irises) {
    g.fillStyle = RIG.pupilInk; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x + r * 0.35, y - r * 0.35, r * 0.3, 0, Math.PI * 2); g.fill();
  }
}

// a superellipse: a bar when n is large, an ellipse at 2
function blob(ex: number, ey: number, n: number): Path2D {
  const p = new Path2D();
  for (let j = 0; j < STEPS; j++) {
    const t = j / STEPS * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    p.lineTo(ex * Math.sign(c) * Math.abs(c) ** (2 / n), ey * Math.sign(s) * Math.abs(s) ** (2 / n));
  }
  p.closePath();
  return p;
}

/** One shape from shut to open: shut, a flat line lying exactly on the painted one; opening, it parts into a slit that grows into an
 *  upright oval, dark red inside with the tongue low on one side. The painted line fades out under it over the first SHUT of the way. */
function drawMouth(g: CanvasRenderingContext2D, art: Art, open: number, alpha: number) {
  const {img, ink} = art.mouthless;
  g.globalAlpha = alpha * Math.min(1, open / SHUT);
  g.drawImage(img, RIG.mouthLine[0], RIG.mouthLine[1]);
  g.globalAlpha = alpha;
  const [lx0, ly0, lx1, ly1, th] = RIG.mouthBar;
  const [mx, my] = RIG.mouth;
  const h = th / 2;
  const f = Math.max(0, (open - SHUT) / (1 - SHUT));
  const rxOpen = TUNING.mouthSize * 0.5;
  const ryOpen = TUNING.mouthSize * 1.1;
  const cyOpen = my - 6 + ryOpen * 0.82;
  const lx = (lx0 + lx1) / 2;
  const ly = (ly0 + ly1) / 2;
  const rx = (lx1 - lx0) / 2 + (rxOpen - (lx1 - lx0) / 2) * f;
  const ry = h + (ryOpen - h) * f;
  const cx = lx + (mx - lx) * f;
  const cy = ly + (ry - h) * (cyOpen - ly) / (ryOpen - h);
  const n = 2 + 6 * (1 - f) ** 8;
  g.save(); g.translate(cx, cy); g.rotate(Math.atan2(ly1 - ly0, lx1 - lx0) * (1 - f) + RIG.mouthTilt * f);
  g.fillStyle = ink; g.fill(blob(rx, ry, n));
  // just parted, the line splits into two thin lips rather than thickening into a bar
  const ring = Math.min(LIP, Math.max(h, ry * 0.45));
  const ix = rx - ring;
  const iy = ry - ring;
  if (iy > 0.2) {
    const inside = blob(ix, iy, n);
    g.fillStyle = RIG.mouthInside; g.fill(inside); g.clip(inside);
    g.fillStyle = RIG.mouthTongue; g.beginPath(); g.ellipse(-ix * 0.3, iy * 0.78, ix * 0.85, iy * 0.55, -0.12, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/** The ant in its frame's px (the caller has set the transform): back arm, body, pupils, mouth, front arm. */
export function drawAnt(g: CanvasRenderingContext2D, art: Art, pose: Pose, alpha: number): void {
  RIG.arms.forEach((a, i) => { if (a.under) drawArm(g, art, i, pose.lifts[i]); });
  g.drawImage(pose.body, 0, 0, RIG.size, RIG.size);
  drawPupils(g, pose.irises);
  if (pose.open > 0) drawMouth(g, art, pose.open, alpha);
  RIG.arms.forEach((a, i) => { if (!a.under) drawArm(g, art, i, pose.lifts[i]); });
}

/** The rim: white, less the ant moved by the offset and blurred, kept inside the ant. */
export function drawRim(rim: CanvasRenderingContext2D, ant: HTMLCanvasElement, unit: number): void {
  const {dx, dy, blur} = TUNING.shade;
  const {width: w, height: h} = ant;
  rim.setTransform(1, 0, 0, 1, 0, 0); rim.globalCompositeOperation = 'source-over'; rim.filter = 'none';
  rim.fillStyle = '#fff'; rim.fillRect(0, 0, w, h);
  rim.globalCompositeOperation = 'destination-out'; rim.filter = `blur(${blur * unit}px)`; rim.drawImage(ant, dx * unit, dy * unit);
  rim.globalCompositeOperation = 'destination-in'; rim.filter = 'none'; rim.drawImage(ant, 0, 0);
}
