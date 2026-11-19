/** A watercolour in both themes, with optional phone cuts: the same picture at the width a phone draws it (up to 560px screens). */
export type Painting = {day: string; night: string; dayPhone?: string; nightPhone?: string};

/** Where the phone cuts are used, and where not; Wash.module.css repeats this width. */
export const PHONE_PAINTINGS = '(max-width: 560px)';
export const WIDE_PAINTINGS = '(min-width: 561px)';

/** The painting at `base` (`base-day.webp`, `base-night.webp`), and its `-phone` cuts when `phone`. */
export function painting(base: string, phone = false): Painting {
  const day = `${base}-day.webp`;
  const night = `${base}-night.webp`;
  return phone ? {day, night, dayPhone: `${base}-day-phone.webp`, nightPhone: `${base}-night-phone.webp`} : {day, night};
}

const DIR = '/site/assets/paintings';

/** The landscapes several pages share. A phone cut exists where it is meaningfully smaller than the full painting. */
export const PAINTINGS = {
  horizon: painting(`${DIR}/horizon`, true),
  clover: painting(`${DIR}/clover`),
  birches: painting(`${DIR}/birches`, true),
  shore: painting(`${DIR}/shore`, true),
  ferns: painting(`${DIR}/ferns`, true),
  river: painting(`${DIR}/river`),
  poppies: painting(`${DIR}/poppies`, true),
  pond: painting(`${DIR}/pond`, true),
  harvest: painting(`${DIR}/harvest`, true),
} satisfies Record<string, Painting>;

export type PaintingName = keyof typeof PAINTINGS;

const LIGHT = '(prefers-color-scheme: light)';
const DARK = '(prefers-color-scheme: dark)';

/** The painting the first paint will show, asked for at once: per system theme, and per screen when it has phone cuts. */
export function paintingPreloads({day, night, dayPhone, nightPhone}: Painting): {href: string; media: string}[] {
  if (!dayPhone || !nightPhone) return [{href: day, media: LIGHT}, {href: night, media: DARK}];
  return [
    {href: day, media: `${LIGHT} and ${WIDE_PAINTINGS}`}, {href: night, media: `${DARK} and ${WIDE_PAINTINGS}`},
    {href: dayPhone, media: `${LIGHT} and ${PHONE_PAINTINGS}`}, {href: nightPhone, media: `${DARK} and ${PHONE_PAINTINGS}`},
  ];
}
