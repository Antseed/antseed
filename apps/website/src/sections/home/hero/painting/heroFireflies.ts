import type {FlyPlace} from '../../../../lib/fireflies/engine';

/** The hero night's fireflies: far ones toward the ridge, mid ones over the meadow, near ones flying in front (1376×768 painting). */
export const HERO_FLIES: FlyPlace = {
  seed: 11, img: [1376, 768], fit: [0.5, 0],
  matte: {src: '/site/assets/hero/meadow-night-matte.webp', top: 499},
  groups: [
    {kind: 'far', n: 13, phoneN: 7, y: [492, 548], d: [5, 8], a: [0.55, 0.9]},
    {kind: 'mid', n: 6, phoneN: 3, y: [540, 600], d: [10, 15], a: [0.6, 0.9]},
    {kind: 'near', n: 7, phoneN: 4, y: [555, 670], d: [30, 42], a: [0.9, 1], roam: [80, 40]},
  ],
};
