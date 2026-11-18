import {flushSync} from 'react-dom';
import {prefersReducedMotion} from './motion';

type ColorModeChoice = 'light' | 'dark' | null;

/** Sets the color mode inside a view transition (a crossfade of the whole page); instantly with reduced motion or without view
 *  transition support. `null` follows the system. */
export function setThemeAnimated(setColorMode: (m: ColorModeChoice) => void, mode: ColorModeChoice): void {
  const doc = document as Document & {startViewTransition?: (cb: () => void) => unknown};
  const apply = () => flushSync(() => setColorMode(mode));
  if (doc.startViewTransition && !prefersReducedMotion()) doc.startViewTransition(apply);
  else apply();
}

/** True while the site shows its dark theme (Docusaurus' <html data-theme>). */
export const isDarkTheme = (): boolean => document.documentElement.dataset.theme === 'dark';

/** Calls `fn` whenever the site theme flips; returns the unsubscribe. */
export function onThemeChange(fn: () => void): () => void {
  const mo = new MutationObserver(fn);
  mo.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  return () => mo.disconnect();
}
