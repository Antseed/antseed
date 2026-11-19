// Imported by docusaurus.config.ts (Node), so this file must not import anything.

/** Geist Pixel (the marketing titles), self-hosted, variable on its ELSH axis. */
export const PIXEL_FONT_URL = '/site/assets/fonts/geist-pixel.woff2';

/**
 * Its face, declared in the head next to its preload, so the stylesheet asks for the very URL the preload fetched (a face in the
 * bundled CSS would point at a hashed copy, downloading the font twice). `swap`: the preload makes the font there before first paint
 * on a warm load, and `swap` keeps the title from blocking render on a slow one (it shows in a fallback, then swaps) instead of
 * holding paint, which Lighthouse counts against the page.
 */
export const PIXEL_FONT_FACE = `@font-face{font-family:'Geist Pixel';src:url(${PIXEL_FONT_URL}) format('woff2');font-weight:400;font-display:swap}`;
