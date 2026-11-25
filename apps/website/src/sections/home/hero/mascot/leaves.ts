import {ASSETS} from '../data';
import {loadImage} from './art';
import {loadPlants, type Plants} from './poser';

/* The plants in front of the mascot's lower body, drawn on their own canvas over it. Above the bandana they pass behind it, fading
   out; they never cover its eyes or mouth. By day they follow the film's frame; at night the night painting's plants, posed once as
   its plants stand, and kept to the mascot only. They move with the painting: its arrival (the cover and the settling scale) and the
   theme's fade. */

const NIGHT_POSE = 92;          // the film frame the night was painted from
const CAP = 668;                // art row above which the plants pass behind the mascot
const FADE = 36;                // CSS px over which they fade there
const FACE: [number, number, number, number][] = [[525, 422, 84, 84], [717, 417, 66, 77], [640, 500, 58, 52]];   // eyes and mouth: centre and radii
const FACE_SOFT = 0.83;         // the face ovals' hard share, then soft to their edge
const FACE_GROW = 1.2;
const CORNER: [number, number] = [0.45, 0.3];   // the plants live in the painting's bottom right from these shares

/** Where the mascot is: its frame's origin and scale in card px, and how shown. */
export type Frame = {fx: number; fy: number; k: number; shown: number};

type Els = {fore: HTMLCanvasElement; paint: HTMLElement; night: HTMLElement; film: HTMLVideoElement | null; puppet: HTMLCanvasElement};

export class Leaves {
  private readonly g: CanvasRenderingContext2D;
  private readonly tmp = document.createElement('canvas').getContext('2d')!;
  private plants: Plants | null = null;
  private loading = false;
  private nightStill: HTMLImageElement | null = null;
  private nightPose: HTMLCanvasElement | null = null;
  private nightKey = '';
  private drawn: [number, number, number, number] | null = null;
  private frame: Frame = {fx: 0, fy: 0, k: 0, shown: 0};
  private raf = 0;
  private filmTime = -1;
  private disposed = false;

  constructor(private readonly els: Els, private readonly still: boolean) {
    this.g = els.fore.getContext('2d')!;
    // a drawing on each of the film's frames, with that frame's own time
    const film = els.film;
    if (!film || still) return;
    if (film.requestVideoFrameCallback) {
      const onFrame: VideoFrameRequestCallback = (_, meta) => {
        if (this.disposed) return;
        this.filmTime = meta.mediaTime; this.queue(); film.requestVideoFrameCallback(onFrame);
      };
      film.requestVideoFrameCallback(onFrame);
    } else film.addEventListener('timeupdate', this.queue);
  }

  /** The mascot moved: draw again on the next frame. */
  update(frame: Frame): void {
    const f = this.frame;
    if (f.fx === frame.fx && f.fy === frame.fy && f.k === frame.k && Math.abs(f.shown - frame.shown) <= 0.005) return;
    this.frame = {...frame};
    this.queue();
  }

  queue = (): void => { if (!this.raf) this.raf = requestAnimationFrame(this.draw); };

  dispose(): void { this.disposed = true; this.els.film?.removeEventListener('timeupdate', this.queue); cancelAnimationFrame(this.raf); this.raf = 0; this.g.clearRect(0, 0, this.els.fore.width, this.els.fore.height); }

  private load() {
    this.loading = true;
    loadPlants().then((p) => { this.plants = p; this.queue(); });
    loadImage(ASSETS.night).then((i) => { this.nightStill = i; this.queue(); });
  }

  private draw = () => {
    this.raf = 0;
    const {fore, paint, night, film, puppet} = this.els;
    const g = this.g;
    const cover = paint.querySelector<HTMLCanvasElement>('[data-arrival-cover]');
    const veiled = !!paint.querySelector('[data-veil]');
    // the painting is moving on its own (arriving, the theme's fade): follow it every frame until it rests
    if (veiled || cover || 'arriving' in paint.dataset || 'theming' in paint.dataset) this.queue();
    const cw = paint.offsetWidth;
    const ch = paint.offsetHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (fore.width !== Math.round(cw * dpr) || fore.height !== Math.round(ch * dpr)) { fore.width = Math.round(cw * dpr); fore.height = Math.round(ch * dpr); this.drawn = null; }
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (this.drawn) g.clearRect(...this.drawn); else g.clearRect(0, 0, fore.width, fore.height);
    this.drawn = null;
    const f = this.frame;
    if (veiled || f.shown < 0.01 || !fore.offsetParent) return;
    if (!this.loading) return this.load();
    const plants = this.plants;
    if (!plants) return;

    const X = paint.offsetLeft;
    const Y = paint.offsetTop;
    const at = (hx: number, hy: number): [number, number] => [hx - X, hy - Y];
    const capY = at(0, f.fy + CAP * f.k)[1];
    const rx = Math.max(0, Math.floor(cw * CORNER[0] * dpr));
    const ry = Math.max(0, Math.floor(ch * CORNER[1] * dpr));
    const rw = fore.width - rx;
    const rh = fore.height - ry;
    const tmp = this.tmp;
    if (rw <= 0 || rh <= 0) return;
    if (tmp.canvas.width !== rw || tmp.canvas.height !== rh) { tmp.canvas.width = rw; tmp.canvas.height = rh; }
    const stage = paint.firstElementChild as HTMLElement | null;
    const settle = 'arriving' in paint.dataset && stage ? parseFloat(getComputedStyle(stage).scale) || 1 : 1;
    const local = (c: CanvasRenderingContext2D) => { c.setTransform(dpr, 0, 0, dpr, -rx, -ry); c.translate(cw / 2, ch / 2); c.scale(settle, settle); c.translate(-cw / 2, -ch / 2); };
    const share = parseFloat(getComputedStyle(night).getPropertyValue('--night-share')) || 0;

    // one painting's plants at their place, kept to their share of the night, laid on the canvas
    const layer = (picture: CanvasImageSource, rect: [number, number, number, number], op: GlobalCompositeOperation | null, onAnt: boolean) => {
      tmp.globalCompositeOperation = 'source-over'; tmp.setTransform(1, 0, 0, 1, 0, 0); tmp.clearRect(0, 0, rw, rh);
      local(tmp); tmp.imageSmoothingQuality = 'high'; tmp.drawImage(picture, ...rect);
      if (op) { tmp.globalCompositeOperation = op; tmp.fillStyle = `rgba(0, 0, 0, ${share})`; tmp.fillRect(-cw, -ch, cw * 3, ch * 3); }
      if (onAnt) {
        tmp.globalCompositeOperation = 'destination-in'; tmp.setTransform(dpr, 0, 0, dpr, -dpr * X - rx, -dpr * Y - ry);
        tmp.drawImage(puppet, 0, 0, puppet.width / dpr, puppet.height / dpr);
      }
      g.drawImage(tmp.canvas, rx, ry);
    };
    if (share < 1) {   // the day: on the film's 16:9 stage, covering the painting from its centre, as the frame shown
      const sw = Math.max(cw, ch * 16 / 9);
      const sh = sw * 9 / 16;
      const sx = Math.round((cw - sw) / 2);
      const sy = Math.round((ch - sh) / 2);
      const u = sw / 1920;
      const [px, py, pw, ph] = plants.units.day;
      const k = plants.day.height / (ph * u);
      const shown = film && film.readyState >= 2 && film.currentTime > 0 && !this.still;
      const n = shown ? Math.round((this.filmTime >= 0 ? this.filmTime : film.currentTime) * plants.units.fps) % plants.units.frames : -1;
      layer(plants.day(n, (capY - (sy + py * u)) * k, FADE * k), [sx + px * u, sy + py * u, pw * u, ph * u], share > 0 ? 'destination-out' : null, false);
    }
    const still = this.nightStill;
    if (share > 0 && plants.night && still) {   // the night: on the night still, covering from the top, over the mascot only
      const u = Math.max(cw / still.naturalWidth, ch / still.naturalHeight);
      const nx = (cw - still.naturalWidth * u) / 2;
      const [px, py, pw, ph] = plants.units.night;
      const k = plants.day.height / (ph * u);
      const key = `${Math.round((capY - py * u) * k)} ${Math.round(FADE * k)}`;
      if (key !== this.nightKey) {   // kept in a canvas of its own: the posed one is reused
        const posed = plants.night(NIGHT_POSE, (capY - py * u) * k, FADE * k); this.nightKey = key;
        this.nightPose ||= Object.assign(document.createElement('canvas'), {width: posed.width, height: posed.height});
        const c = this.nightPose.getContext('2d')!; c.clearRect(0, 0, posed.width, posed.height); c.drawImage(posed, 0, 0);
      }
      layer(this.nightPose!, [nx + px * u, py * u, pw * u, ph * u], share < 1 ? 'destination-in' : null, true);
    }
    // where the painting has not arrived yet, neither have its leaves; and never over the eyes or the mouth
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    if (cover) g.drawImage(cover, 0, 0, cw, ch);
    for (const [ex, ey, erx, ery] of FACE) {
      const [ox, oy] = at(f.fx - ex * f.k, f.fy + ey * f.k);   // mirrored art
      g.save(); g.translate(ox, oy); g.scale(erx * f.k * FACE_GROW, ery * f.k * FACE_GROW);
      const face = g.createRadialGradient(0, 0, 0, 0, 0, 1); face.addColorStop(FACE_SOFT, '#000'); face.addColorStop(1, '#0000');
      g.fillStyle = face; g.beginPath(); g.arc(0, 0, 1, 0, Math.PI * 2); g.fill(); g.restore();
    }
    g.globalCompositeOperation = 'source-over';
    this.drawn = [rx, ry, rw, rh];
  };
}

