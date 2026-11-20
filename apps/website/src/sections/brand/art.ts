import type {Feature} from '../../parts/FeatureList';
import {PAINTINGS, type Painting} from '../../lib/paintings';

export type ArtPoint = {
  cmp: string;
  id: string;
  eyebrow: string;
  title: readonly [string, string];
  sub: string;
  features: readonly Feature[];
  painting: Painting & {label: string};
  /** Painting on the left on wide screens. */
  flip?: boolean;
};

export const ART: readonly ArtPoint[] = [
  {
    cmp: 'brand/paintings',
    id: 'paintings',
    eyebrow: 'Paintings',
    title: ['Watercolour,', 'mostly white paper.'],
    sub: 'Small, sparse landscapes from a nature picture book: transparent washes, few elements, the subject low or at the sides, the quiet centre left for titles and glass.',
    features: [
      {icon: 'check', text: 'Every painting has its own night, never a filter on the day'},
      {icon: 'check', text: 'Nights are deep blue-green; warmth comes from seeds, one window, fireflies'},
      {icon: 'check', text: 'A painting arrives once, through a matrix of round dots'},
    ],
    painting: {
      ...PAINTINGS.pond,
      label: 'A watercolour pond with reeds, bulrushes and lily pads under a pale sky',
    },
  },
  {
    cmp: 'brand/ant',
    id: 'ant',
    eyebrow: 'The ant',
    title: ['One round ant,', 'a little lost.'],
    sub: 'Chubby and warm brown, with an enormous head, huge white eyes looking two ways, ball-tipped antennae, a lime bandana and exactly two legs. Deadpan by default; it carries things and gets amazed.',
    features: [
      {icon: 'user', text: 'Roles are props on the same body: glasses and a hoodie for a provider'},
      {icon: 'check', text: 'One character, never a realistic insect or a second design'},
      {icon: 'check', text: 'Anywhere else, an ant is a dot'},
    ],
    painting: {
      day: '/site/assets/home/providers/stall-day.webp',
      night: '/site/assets/home/providers/stall-night.webp',
      label: 'The ant in glasses and a hoodie at its market stall in a birch wood, a price sign reading $0.02/M',
    },
    flip: true,
  },
];
