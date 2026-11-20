import type {Title} from '../../../components';
import type {SceneName} from '../../../parts/ProviderFilm/scenes';

export type ProviderPath = {
  id?: string;
  title: Title;
  copy: string;
  cta: {href: string; label: string};
  scene: SceneName;
  painting: {day: string; night: string; label: string};
};

const PAINTINGS = '/site/assets/home/providers';

export const PATHS: readonly ProviderPath[] = [
  {
    title: 'Become your own provider.',
    copy: 'Serve open models on your GPUs, capacity you hold, a router you built, a specialized service or an agent. Set your terms, build your reputation and reach buyers across the network.',
    cta: {href: '/providers/', label: 'Become a provider →'},
    scene: 'stall',
    painting: {
      day: `${PAINTINGS}/stall-day.webp`,
      night: `${PAINTINGS}/stall-night.webp`,
      label: 'An ant in round glasses and a grey hoodie keeps its own market stall in a birch wood, a price board hanging at its side, baskets on the counter and a small silver computer at its foot',
    },
  },
  {
    id: 'colony',
    title: ['Join a Colony.', 'Or\u00a0create\u00a0one'],
    copy: 'Join together with others and let your machine serve while you’re away. We started the first one, Antseed Colony. The idea is a network of many Colonies.',
    cta: {href: '/colony/', label: 'Explore Colonies →'},
    scene: 'colony',
    painting: {
      day: `${PAINTINGS}/colony-day.webp`,
      night: `${PAINTINGS}/colony-night.webp`,
      label: 'Three ants in hoodies tend their Mac Studios on a meadow: one polishes its Mac with a cloth, one peers at the glowing seed in the middle, one pats its Mac. Each Mac Studio is joined to the seed by a glowing root.',
    },
  },
];

export const LISTING: readonly {term: string; value: string}[] = [
  {term: 'Models & services', value: 'You choose'},
  {term: 'Price per request', value: 'You set'},
  {term: 'Buyer connection', value: 'Direct'},
];
