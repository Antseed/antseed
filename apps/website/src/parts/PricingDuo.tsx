import {useRef, type JSX} from 'react';
import {Actions, Button, Duo, Heading, Sub, Wash} from '../components';
import {PixelIcon} from './PixelIcon';
import {ModelCard} from './ModelCard';
import {useMarket} from '../lib/antscan';
import styles from './PricingDuo.module.css';
import {PAINTINGS} from '../lib/paintings';
import {sectionTitleId} from '../lib/sectionTitleId';

const LIVE_PRICES = 'https://antseedstats.com/network';
const SHOWN = 4;

type Props = {
  cmp: string;
  id?: string;
  /** The title's first line, in ink, and its second, in grey. */
  title: string;
  accent: string;
  lead: string;
};

/** What it costs: the page's promise beside the network's most used text models and their prices (live), over a painting. */
export function PricingDuo({cmp, id, title, accent, lead}: Props): JSX.Element {
  const titleId = sectionTitleId(cmp);
  const cardsRef = useRef<HTMLUListElement>(null);
  const cards = useMarket(cardsRef).lanes.text.filter((m) => m.price !== null).slice(0, SHOWN);
  return (
    <Duo
      cmp={cmp}
      id={id}
      labelledBy={titleId}
      text={
        <>
          <div data-rv="">
            <div className={styles.head}>
              <Heading id={titleId} title={[title, accent]} secondLine="break" strong className={styles.title} />
              <Sub className={styles.lead}>{lead}</Sub>
            </div>
          </div>
          <Actions className={styles.actions}><Button href={LIVE_PRICES} variant="ghost">Live prices&nbsp;↗</Button></Actions>
          <p className={styles.note} data-rv="">
            <PixelIcon name="check" className={styles.icon} />
            You only pay for what you use. Settlement goes straight to the provider, in USDC on Base.
          </p>
        </>
      }
      panel={
        <Wash unveil reveal="panel" className={styles.panel} {...PAINTINGS.harvest}>
          <ul ref={cardsRef} className={styles.cards} aria-label="Prices on the network">
            {cards.map((m) => <ModelCard key={m.name} model={m} medium="text" className={styles.card} />)}
          </ul>
        </Wash>
      }
    />
  );
}
