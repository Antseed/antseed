import {loadImage} from './art';

/* The meadow's nearest plants (daisies, clover, stems, sprigs), painted again on their own and laid exactly over their twins in the
   painting so they can stand in front of the mascot. By day they sway as the film's do, in step with its frame: each flower head is
   carried whole and turned on its stem by the film's measured motion; each stem bends from its foot; the rest of the leaves follow the
   film's broad sway field, gently. */

const LEAVES = '/site/assets/hero/plants-day';
const NIGHT_LEAVES = '/site/assets/hero/plants-night';
const MAX_STEMS = 8;            // the shader's fixed number of stems
const HEAD_LEAN = 0.6;          // how far a head turns with its stem
const BROAD_SWAY = 0.5;         // the broad field, at half

type Head = {c: [number, number]; foot: [number, number]; sprite: [number, number, number, number]; box: [number, number]; dx: number[]; dy: number[]};
type Stem = {tip: [number, number]; foot: [number, number]; dx: number[]};
/** The film's measured motion (plants-day.json): fps, frame count, heads, stems, broad field, and each plate's box. */
export type Units = {fps: number; frames: number; heads: Head[]; stems: Stem[]; field: {max: number; w1: number[]};
  day: [number, number, number, number]; night: [number, number, number, number]};

/** Plants posed as at film frame `n` (n < 0: as painted), cut above row `cap` (fading over `fade` px) where they pass behind. */
export type Poser = ((n: number, cap?: number, fade?: number) => HTMLCanvasElement) & {height: number};

const VERTEX = 'attribute vec2 p; varying vec2 uv; void main() { uv = p * 0.5 + 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }';
// sampled backwards: near each stem its sway, none at its foot, all at its tip, the square of the height between; elsewhere the field
const FRAGMENT = `precision highp float; varying vec2 uv; uniform sampler2D P, F; uniform vec2 size; uniform float broad;
  uniform vec4 stem[${MAX_STEMS}]; uniform vec3 sway[${MAX_STEMS}];
  void main() {
    vec2 p = uv * size, d = vec2(0.0); float near = 0.0;
    for (int i = 0; i < ${MAX_STEMS}; i++) {
      vec4 s = stem[i]; float t = clamp((s.w - p.y) / max(1.0, s.w - s.y), 0.0, 1.0);
      float g = exp(-0.5 * pow((p.x - mix(s.z, s.x, t)) / max(1.0, sway[i].z), 2.0)) * step(0.5, sway[i].z);
      d += sway[i].xy * t * t * g; near += g;
    }
    vec4 f = texture2D(F, uv); d = d / max(1.0, near) + (1.0 - min(1.0, near)) * (f.rg - 0.5) * broad;
    gl_FragColor = texture2D(P, uv - d / size);
  }`;

type Control = {tip: [number, number]; foot: [number, number]; dx: number[]; dy: number[] | null; sig: number};

/** The body bent on the graphics card, or null without WebGL (the body then stays as painted; the heads still move). */
function bender(body: HTMLImageElement, field: HTMLImageElement, ctl: Control[], units: Units): ((n: number) => HTMLCanvasElement) | null {
  const c = Object.assign(document.createElement('canvas'), {width: body.naturalWidth, height: body.naturalHeight});
  const gl = c.getContext('webgl', {premultipliedAlpha: true, antialias: false});
  if (!gl) return null;
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
    const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog); gl.useProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  ([[body, true], [field, false]] as const).forEach(([img, premultiply], i) => {
    gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  });
  const u = (n: string) => gl.getUniformLocation(prog, n);
  gl.uniform1i(u('P'), 0); gl.uniform1i(u('F'), 1); gl.uniform2f(u('size'), c.width, c.height);
  gl.uniform4fv(u('stem'), new Float32Array(Array.from({length: MAX_STEMS}, (_, i) => (ctl[i] ? [...ctl[i].tip, ...ctl[i].foot] : [0, 0, 0, 1])).flat()));
  const swayAt = u('sway');
  const broadAt = u('broad');
  gl.viewport(0, 0, c.width, c.height); gl.clearColor(0, 0, 0, 0);
  return (n) => {
    gl.uniform3fv(swayAt, new Float32Array(Array.from({length: MAX_STEMS}, (_, i) => (ctl[i] ? [ctl[i].dx[n], ctl[i].dy ? ctl[i].dy![n] : 0, ctl[i].sig] : [0, 0, 0])).flat()));
    gl.uniform1f(broadAt, units.field.max * 2 * units.field.w1[n] * BROAD_SWAY);
    gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return c;
  };
}

function poser(body: HTMLImageElement, heads: HTMLImageElement, field: HTMLImageElement, units: Units): Poser {
  const out = Object.assign(document.createElement('canvas'), {width: body.naturalWidth, height: body.naturalHeight});
  const g = out.getContext('2d')!;
  const ctl: Control[] = [...units.heads.map((h) => ({tip: h.c, foot: h.foot, dx: h.dx, dy: h.dy, sig: 18})),
    ...units.stems.map((s) => ({tip: s.tip, foot: s.foot, dx: s.dx, dy: null, sig: 26}))].slice(0, MAX_STEMS);
  const bend = bender(body, field, ctl, units);
  const pose = (n: number, cap = -Infinity, fade = 0) => {
    g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, out.width, out.height);
    g.drawImage(n >= 0 && bend ? bend(n) : body, 0, 0);
    if (cap > 0) {
      const gr = g.createLinearGradient(0, cap - fade, 0, cap); gr.addColorStop(0, '#0000'); gr.addColorStop(1, '#000');
      g.globalCompositeOperation = 'destination-in'; g.fillStyle = gr; g.fillRect(0, 0, out.width, out.height); g.globalCompositeOperation = 'source-over';
    }
    for (const h of units.heads) {   // each head whole, on its stem's tip, leaning as the stem does; above the cap, behind
      const dx = n >= 0 ? h.dx[n] : 0;
      const dy = n >= 0 ? h.dy[n] : 0;
      const [cx, cy] = h.c;
      const [sx, sy, sw, sh] = h.sprite;
      const [bx, by] = h.box;
      if (cy + dy < cap - fade / 2) continue;
      g.save(); g.translate(cx + dx, cy + dy); g.rotate(Math.atan2(dx, h.foot[1] - cy) * HEAD_LEAN);
      g.drawImage(heads, sx, sy, sw, sh, bx - cx, by - cy, sw, sh); g.restore();
    }
    return out;
  };
  return Object.assign(pose, {height: out.height});
}

export type Plants = {units: Units; day: Poser; night: Poser | null};

/** Fetches the plates and the film's motion, and builds the day's and the night's posers. */
export async function loadPlants(): Promise<Plants | null> {
  const [images, units] = await Promise.all([
    Promise.all([`${LEAVES}.webp`, `${LEAVES}-heads.webp`, `${NIGHT_LEAVES}.webp`, `${NIGHT_LEAVES}-heads.webp`, `${LEAVES}-sway.png`].map(loadImage)),
    fetch(`${LEAVES}.json`).then((r) => r.json() as Promise<Units>).catch(() => null),
  ]);
  const [body, heads, nBody, nHeads, field] = images;
  if (!body || !heads || !field || !units) return null;
  return {units, day: poser(body, heads, field, units), night: nBody && nHeads ? poser(nBody, nHeads, field, units) : null};
}
