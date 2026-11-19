/* The mascot's rig. Every point is in the art's own px: the parts share one 1024 × 1024 frame, and the art faces right and is drawn
   mirrored so it faces the middle of the card. */

const DIR = '/site/assets/hero/ant-rig';

export type Arm = {src: string; shoulder: [number, number]; rest: number; under: boolean};
export type Eye = {x: number; y: number; rx: number; ry: number};
export type Antenna = {box: [number, number, number, number]; ball: number; sway: number; lag: number};

export const RIG = {
  body: `${DIR}/ant-body.webp`,          // the neutral pose with the arms painted out
  size: 1024,
  bounds: [252, 115, 772, 928] as const,   // the ant's drawn box in the frame
  eyes: [{x: 525, y: 422, rx: 64, ry: 64}, {x: 717, y: 417, rx: 46, ry: 57}] as Eye[],
  pupil: 16, pupilInk: '#2b1b12',
  /** the lost look at rest: each eye's way in the art, apart and sideways */
  lost: [-1, 1],
  mouth: [640, 485] as const,
  /** the painted closed mouth's box, painted out under the open one */
  mouthLine: [612, 470, 668, 500] as const,
  /** the painted line between its end ticks: both ends and its thickness */
  mouthBar: [624, 484.9, 654, 484.5, 3.5] as const,
  mouthInk: '#3a1209', mouthInside: '#782b1c', mouthTongue: '#e8a497', mouthTilt: 0.08,
  /** above the head the antennae sway: each one's box (left, top, right, base row), the row under its ball, its tip's reach and lag */
  antennae: [{box: [480, 110, 588, 253], ball: 184, sway: 6, lag: 0}, {box: [626, 156, 750, 271], ball: 229, sway: 5, lag: 0.55}] as Antenna[],
  /** arms turn round their shoulders; the back arm hides behind the body at rest */
  arms: [
    {src: `${DIR}/ant-arm-back.webp`, shoulder: [646, 668], rest: 87, under: true},
    {src: `${DIR}/ant-arm-front.webp`, shoulder: [424, 664], rest: 87, under: false},
  ] as Arm[],
};

/** How the mascot sits and moves. */
export const TUNING = {
  width: 420,               // CSS px, shrunk to clear the install block
  inset: 40,                // its right edge from the card's right
  crop: 0.22,               // share of its height below the card's bottom edge
  fps: 24,                  // drawn at the painting films' rate
  armSpeed: 6, armLift: 150, pupilTravel: 0.8, jitter: 2.5, mouthSize: 30,
  squintReach: 150,         // px from the bridge of its nose where its eyes cross on the seed
  catchReach: 30,           // px from its mouth where it takes the seed
  chewMs: 1200, bites: 3, crumbs: 5, flyMs: 200, swallowMs: 250,
  gamma: 1.45,              // the art's grade: deeper browns, the eye whites kept white
  rimAlpha: 0.14,           // a white rim lit from the title side
  shade: {dx: 26, dy: 6, blur: 2.4, at: 317},   // the rim's offset and blur, given for a 317px ant
  /** it watches the pointer within its corner: from these shares of the first screen (nav included) */
  zone: [0.42, 0.36] as const,
};
