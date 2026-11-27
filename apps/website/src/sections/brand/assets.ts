import {PAINTINGS, type Painting} from '../../lib/paintings';

const DIR = '/brand/downloads';

export const REFERENCE_ANT = `${DIR}/ant/antseed-ant.png`;
export const ANTS_COIN = `${DIR}/antseed-ants-coin.webp`;
export const ANT_EXAMPLES_ZIP = `${DIR}/antseed-ant-examples.zip`;

const ANT_SLUGS = [
  'user-laptop', 'beanie-leaf', 'you-basket', 'provider-gpu', 'user-coin',
  'beanie-phone', 'you-bulb', 'provider-server', 'user-sprout', 'incognito-padlock',
  'you-card', 'beanie-cable', 'you-envelope', 'user-drive', 'beanie-parcel',
  'you-sugar', 'user-token', 'chip', 'mini', 'ram',
] as const;

/** Twenty finished ants, all on two feet; each file is shown and downloaded as it is. */
export const ANT_EXAMPLES = ANT_SLUGS.map((slug) => ({
  slug,
  thing: slug.split('-').at(-1) as string,
  src: `${DIR}/ant/examples/antseed-ant-${slug}.webp`,
}));

export type Background = Painting & {key: string; name: string; prefix: string};

const texture = (key: string, name: string): Background => ({
  key,
  name,
  prefix: 'antseed-texture',
  day: `${DIR}/textures/antseed-texture-${key}-day.webp`,
  night: `${DIR}/textures/antseed-texture-${key}-night.webp`,
});

const watercolour = (key: string, name: string, painting: Painting): Background => ({
  key,
  name,
  prefix: 'antseed-watercolour',
  day: painting.day,
  night: painting.night,
});

export const TEXTURES: readonly Background[] = [
  texture('meadow', 'Meadow'),
  texture('poppies', 'Poppies'),
  texture('wheat', 'Wheat'),
];

export const WATERCOLOURS: readonly Background[] = [
  watercolour('river', 'River', PAINTINGS.river),
  watercolour('clover', 'Clover', PAINTINGS.clover),
  watercolour('dunes', 'Dunes', PAINTINGS.shore),
  watercolour('birches', 'Birches', PAINTINGS.birches),
  watercolour('ferns', 'Ferns', PAINTINGS.ferns),
  watercolour('pond', 'Pond', PAINTINGS.pond),
];

/** What the example prompt painted: a reference for the style, not a picture to reuse. */
export const STYLE_REFERENCE = `${DIR}/antseed-watercolour-style-reference.webp`;

export const backgroundFiles = (b: Background) => [
  {label: 'Day', href: b.day, name: `${b.prefix}-${b.key}-day.webp`},
  {label: 'Night', href: b.night, name: `${b.prefix}-${b.key}-night.webp`},
];
