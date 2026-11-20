export type SceneName = 'stall' | 'colony';
export type SetName = 'day' | 'night';

export type Pupil = {
  /** Offset of the pupil at rest (where it is painted), as a share of its eye box. */
  rest: readonly [number, number];
  /** How far it may travel toward the pointer, as a share of its eye box. */
  travel: readonly [number, number];
};

type Scene = {
  /** The painting's own aspect ratio (its poster). */
  aspect: string;
  /** The stall's extra layers: the swinging price board, the ant cut from the painting, its pupils. */
  stall: boolean;
};

export const SCENES: Record<SceneName, Scene> = {
  stall: {aspect: '1600 / 1074', stall: true},
  colony: {aspect: '1600 / 1073', stall: false},
};

export const PUPILS: readonly [Pupil, Pupil] = [
  {rest: [-0.0742, -0.0789], travel: [0.3546, 0.3553]},
  {rest: [0.2813, -0.0487], travel: [0.295, 0.3384]},
];

const BASE = '/site/assets/home/providers';
export const filmBase = (scene: SceneName, set: SetName) => `${BASE}/${scene}-${set}`;
export const stallArt = (part: 'sign' | 'ant', set: SetName) => `${BASE}/stall-${part}-${set}.webp`;

export const pupilTransform = (x: number, y: number) => `translate(${(x * 100).toFixed(2)}%, ${(y * 100).toFixed(2)}%)`;
