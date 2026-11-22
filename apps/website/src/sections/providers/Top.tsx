import type {JSX} from 'react';
import {Button} from '../../components';
import {FirstScreen} from '../../parts/FirstScreen';
import {ProviderFilm} from '../../parts/ProviderFilm/ProviderFilm';
import styles from './Top.module.css';

const MIN_HEIGHT = 480;

/** The first screen: the offer beside the own-provider stall. */
export function Top(): JSX.Element {
  return (
    <FirstScreen
      cmp="providers/top"
      titleId="providers-title"
      className={styles.top}
      eyebrow="Your own provider"
      title={['Your service.', 'Your price. Your buyers.']}
      strong
      secondLine="block"
      sub="Offer open models on your GPUs, capacity you hold, a router you built, a specialized service or an agent."
      subWidth={460}
      subClassName={styles.sub}
      actions={<Button href="/docs/provide/" size="page">Set up your provider →</Button>}
      fillActions
      fit
      minHeight={MIN_HEIGHT}
      onRail
      painting={{
        day: '/site/assets/home/providers/stall-day.webp',
        night: '/site/assets/home/providers/stall-night.webp',
        // 85% down, so the ant and its board stay in the middle at any shape
        focus: '50% 85%',
        label: 'An ant in round glasses and a grey hoodie keeps its own market stall in a birch wood, a price board hanging at its side, baskets on the counter and a small computer by the stall',
      }}>
      <ProviderFilm scene="stall" className={styles.film} />
    </FirstScreen>
  );
}
