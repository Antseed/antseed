import {isDarkTheme} from './theme';
import {PHONE_PAINTINGS} from './paintings';

/** The LED dot grid shared by the painting's arrival and the cursor trail, so both effects line up on the same cells. */
export const LED_PITCH = 8;
/** A dot's radius as a share of the pitch. */
export const LED_DOT = 0.42;
const MAX_DPR = 2;

export const canvasDpr = (): number => Math.min(MAX_DPR, window.devicePixelRatio || 1);

/** A stable pseudo-random value in [0, 1) per cell and seed, so the pattern is the same on every run. */
export function cellHash(x: number, y: number, seed: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return v - Math.floor(v);
}

/** The painting a panel shows in the current theme and screen size, from Wash's --wash(-night)(-phone) variables. */
export function paintingUrl(el: HTMLElement): string | null {
  const cs = getComputedStyle(el);
  const phone = window.matchMedia(PHONE_PAINTINGS).matches;
  const read = (name: string) => cs.getPropertyValue(name).trim();
  const forScreen = (name: string) => (phone && read(`${name}-phone`)) || read(name);
  const value = (isDarkTheme() && forScreen('--wash-night')) || forScreen('--wash');
  const m = /url\(\s*['"]?([^'")]+)/.exec(value);
  return m ? new URL(m[1], document.baseURI).href : null;
}
