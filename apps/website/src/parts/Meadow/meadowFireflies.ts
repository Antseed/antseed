import type {FlyPlace} from '../../lib/fireflies/engine';

/** A few near fireflies low over the ants, in the meadow film's 1920×1080 pixels, cropped as the film is (46% across, bottom). */
export const MEADOW_FLIES: FlyPlace = {
  seed: 7, img: [1920, 1080], fit: [0.46, 1],
  groups: [{kind: 'near', n: 3, phoneN: 2, y: [770, 900], x: [560, 1330], d: [48, 64], a: [0.9, 1], roam: [110, 55]}],
};
