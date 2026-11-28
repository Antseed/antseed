// The count a live figure runs when first seen (useCountUp): from 70% of its value, fast then slowing hard. Pure, so it is tested.

/** A figure is its text: a number with an optional prefix and suffix ("19,252", "742.8B", "$397.1K", "Epoch 30"). */
export const COUNT_MS = 2200;
/** A figure waits at 70% of its value, never at 0. */
export const START_SHARE = 0.7;
const ease = (k: number) => (k >= 1 ? 1 : 1 - 2 ** (-10 * k));

export type Figure = {pre: string; post: string; value: number; decimals: number; grouped: boolean};

export function parse(text: string): Figure | null {
  const m = text.match(/^(.*?)(\d[\d,]*(?:\.\d+)?)(.*)$/s);
  if (!m) return null;
  const [, pre, num, post] = m;
  const value = +num.replace(/,/g, '');
  return {pre, post, value, decimals: (num.split('.')[1] || '').length, grouped: num.includes(',') || value >= 1e4};
}

const format = (f: Figure, v: number) =>
  f.pre + v.toLocaleString('en-US', {minimumFractionDigits: f.decimals, maximumFractionDigits: f.decimals, useGrouping: f.grouped}) + f.post;

export const atShare = (text: string, share: number): string => {
  const f = parse(text);
  return f ? format(f, f.value * share) : text;
};

/** How far the count is at `now`, 0 to 1: a frame stamped before `t0` (the observer ran late in its frame) is the start. */
export const countShare = (now: number, t0: number): number => Math.max(0, Math.min(1, (now - t0) / COUNT_MS));

/** The figure's text at `now`, counting from `from` to its value. */
export const countAt = (f: Figure, from: number, now: number, t0: number): string => format(f, from + (f.value - from) * ease(countShare(now, t0)));
