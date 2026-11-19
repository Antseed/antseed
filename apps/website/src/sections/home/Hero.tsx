import type {JSX} from 'react';
import Head from '@docusaurus/Head';
import {ASSETS} from './hero/data';
import {HeroCard} from './hero/HeroCard';
import {NetworkFigures} from './hero/figures/NetworkFigures';
import styles from './hero/Hero.module.css';

/** The homepage's first screen: the hero card, then the band of network figures, above the dotted page. */
export default function Hero(): JSX.Element {
  return (
    <div className={styles.hero}>
      <Head>
        {/* the first screen's painting, asked for at once and first: the day's for a light system, the night's for a dark one */}
        <link rel="preload" as="image" href={ASSETS.poster} fetchPriority="high" media="(prefers-color-scheme: light)" />
        <link rel="preload" as="image" href={ASSETS.night} fetchPriority="high" media="(prefers-color-scheme: dark)" />
      </Head>
      <HeroCard />
      <NetworkFigures />
    </div>
  );
}
