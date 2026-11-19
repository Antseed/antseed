import type {Feature} from '../../parts/FeatureList';
import {ANTS_BASESCAN_URL} from '../../lib/ants';

type Link = {href: string; label: string};

export type TokenPoint = {
  cmp: string;
  id: string;
  eyebrow: Link;
  title: readonly [string, string];
  sub: string;
  features: readonly Feature[];
  actions: readonly [Link, Link];
  painting: {day: string; night: string; label: string};
  /** Painting on the left on wide screens. */
  flip?: boolean;
};

const ART = '/site/assets/home/ants';

export const POINTS: readonly TokenPoint[] = [
  {
    cmp: 'ants/supply',
    id: 'supply',
    eyebrow: {href: '/docs/recognized-usage/', label: 'Supply'},
    title: ['A hard cap', 'of 1.04 billion.'],
    sub: 'No minting beyond emissions and no admin mint. Emissions run in weekly epochs, and unused budget can be burned.',
    features: [
      {icon: 'sliders-horizontal', text: '5M ANTS an epoch at first, halving every 104 epochs'},
      {icon: 'analytics', text: 'Up to 40% to stakers, 20% to usage, 10% to verification'},
      {icon: 'check', text: 'Unused budget burns, up to 30% of each epoch'},
    ],
    actions: [{href: ANTS_BASESCAN_URL, label: '$ANTS on Basescan ↗'}, {href: '/docs/recognized-usage/', label: 'Learn more'}],
    painting: {
      day: `${ART}/supply-day.webp`,
      night: `${ART}/supply-night.webp`,
      label: 'A tall glass jar of green ANTS coins with a fill line near its top; an ant on a ladder pours in the week’s handful, and leftover coins burn on a stone with a little smoke',
    },
  },
  {
    cmp: 'ants/pools',
    id: 'pools',
    eyebrow: {href: '/docs/provide/staking/', label: 'Provider pools'},
    title: ['Stake behind', 'a provider.'],
    sub: 'Only settled, buyer-authorised payments count, weighted by the ANTS staked behind the provider. Rewards follow recognised usage, inside capped ranges.',
    features: [
      {icon: 'lock', text: 'Stake ANTS and receive an lANTS NFT that represents your locked position'},
      {icon: 'analytics', text: 'Stakers’ share grows from 2% toward 40% of emissions'},
      {icon: 'check', text: 'Leaving early burns 5 to 50% of the stake, not rewards'},
    ],
    actions: [{href: '/docs/provide/staking/', label: 'Staking docs'}, {href: '/docs/recognized-usage/', label: 'Learn more'}],
    painting: {
      day: `${ART}/pools-day.webp`,
      night: `${ART}/pools-night.webp`,
      label: 'The provider’s stall in a birch wood: the ant in glasses serves a customer while three ants drop green coins into a clay pot, and coins fly back to them from the stall',
    },
    flip: true,
  },
];
