import type {JSX} from 'react';
import {Button} from '../../components';
import {FirstScreen} from '../../parts/FirstScreen';
import {TokenFigures} from './TokenFigures';
import {TokenScene} from './TokenScene';
import styles from './Token.module.css';
import {PAINTINGS} from '../../lib/paintings';

/** The first screen: what $ANTS is, beside the coin, then its live figures. */
export function Token(): JSX.Element {
  return (
    <FirstScreen
      cmp="ants/token"
      titleId="ants-title"
      className={styles.token}
      gridClassName={styles.grid}
      textClassName={styles.text}
      panelClassName={styles.panel}
      eyebrow="$ANTS details"
      title={['Inference is the currency.', '$ANTS makes it liquid.']}
      titleClassName={styles.title}
      secondLine="block"
      sub="Stake it with providers to get AI on their terms, and your stake stays tradable."
      subWidth={460}
      subClassName={styles.sub}
      actions={<Button href="/docs/provide/staking/" size="page">Staking docs →</Button>}
      fillActions
      gaps={{side: [16, 24, 36], stacked: [16, 24, 28]}}
      tabletRatio="4 / 3"
      painting={PAINTINGS.harvest}
      below={<TokenFigures />}>
      <TokenScene />
    </FirstScreen>
  );
}
