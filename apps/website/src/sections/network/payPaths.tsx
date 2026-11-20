import type {ReactNode} from 'react';
import type {ActionLink} from '../../components';
import type {Feature} from '../../parts/FeatureList';
import styles from './Pay.module.css';
import {PAINTINGS} from '../../lib/paintings';

export type Coin = {src: string; night?: string; width: number; height: number; alt: string};
export type PayPath = {title: string; coin: Coin; features: readonly Feature[]; actions: readonly ActionLink[]};

/** A point on about two short lines. */
const point = (text: ReactNode) => <span className={styles.point}>{text}</span>;

export const PAINTING = PAINTINGS.harvest;

/** USDC at the left facing right, ANTS at the right facing left. */
export const PAY_PATHS: readonly PayPath[] = [
  {
    title: 'USDC pays for the work.',
    coin: {
      src: '/site/assets/home/usdc-coin-cut.webp',
      night: '/site/assets/home/usdc-coin-cut-night.webp',
      width: 544,
      height: 603,
      alt: 'A blue USDC coin, tilted, its face turned toward the $ANTS coin, in watercolour',
    },
    features: [
      {icon: 'laptop', text: point('Payments always use USDC, whether you use the Gateway, Desktop or CLI.')},
      {icon: 'lock', text: point('A budget is reserved before the first request; after each response you sign the running total.')},
      {icon: 'check', text: point('The provider settles on Base and the unused budget returns to you.')},
    ],
    actions: [
      {href: 'https://github.com/Antseed/antseed/releases/latest', label: 'Start earning'},
      {href: '/docs/payments/', label: 'How payments work', variant: 'ghost'},
    ],
  },
  {
    title: 'ANTS gives access to intelligence.',
    coin: {
      src: '/site/assets/home/ants-coin-cut.webp',
      width: 557,
      height: 603,
      alt: 'A green $ANTS coin, tilted, the Antseed ant raised in white on its face, in watercolour',
    },
    features: [
      {icon: 'server', text: point('ANTS holders stake ANTS behind providers they want to support and receive lANTS.')},
      {
        icon: 'message',
        text: point(<>Providers offer free AI for staking. <a className={styles.link} href="https://antseedstats.com/staking/free" target="_blank" rel="noopener noreferrer">Explore Free AI on AntSeedStats&nbsp;↗</a></>),
      },
      {icon: 'sliders-horizontal', text: point(<>ANTS holders lock lANTS to get a free weekly AI allowance. <span className={styles.soon}>(Coming soon)</span></>)},
    ],
    actions: [
      {href: '/docs/provide/staking/', label: 'Staking docs'},
      {href: '/ants/', label: 'Token details', variant: 'ghost'},
    ],
  },
];
