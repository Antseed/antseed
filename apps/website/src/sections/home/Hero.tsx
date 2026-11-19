import type {JSX} from 'react';
import Head from '@docusaurus/Head';
import {ASSETS} from './hero/data';
import {HeroCard} from './hero/HeroCard';
import {NetworkFigures} from './hero/figures/NetworkFigures';
import {PHONE_PAINTINGS, WIDE_PAINTINGS} from '../../lib/paintings';
import styles from './hero/Hero.module.css';

const LIGHT = '(prefers-color-scheme: light)';
const DARK = '(prefers-color-scheme: dark)';
const STILL_PRELOADS = [
  {href: ASSETS.poster, media: `${LIGHT} and ${WIDE_PAINTINGS}`}, {href: ASSETS.night, media: `${DARK} and ${WIDE_PAINTINGS}`},
  {href: ASSETS.posterPhone, media: `${LIGHT} and ${PHONE_PAINTINGS}`}, {href: ASSETS.nightPhone, media: `${DARK} and ${PHONE_PAINTINGS}`},
];

/** The homepage's first screen: the hero card, then the band of network figures, above the dotted page. */
export default function Hero(): JSX.Element {
  return (
    <div className={styles.hero}>
      <Head>
        {/* the first screen's painting, asked for at once and first: the day's for a light system, the night's for a dark one, cut
            for a phone on a phone */}
        {STILL_PRELOADS.map((p) => <link key={p.href} rel="preload" as="image" href={p.href} fetchPriority="high" media={p.media} />)}
      </Head>
      <HeroCard />
      <NetworkFigures />
    </div>
  );
}
