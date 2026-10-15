import type {ReactNode} from 'react';
import styles from '../pages/index.module.css';
import {Button, Reveal, SectionHeader} from './ui';
import {PriceBoard, LIVE_PRICES_URL} from './PriceBoard';
import {DropTrail} from './DropTrail';

/**
 * The pricing section as a whole — drop-trail dots, two-line title with the
 * green second line, lead, the "Live prices" button, the live price board
 * and the settlement note. Shared by the homepage, /agents and /coding so
 * the three stay identical; only the copy differs. The download button
 * lives in the hero and the closing band, not here.
 */


export function PricingBlock({
  title,
  accent,
  lead,
  dropTrail = true,
}: {
  /** first line of the title (ink) */
  title: ReactNode;
  /** second line of the title (green) */
  accent: ReactNode;
  lead: string;
  /** the dotted line dropping in from the section above (homepage only) */
  dropTrail?: boolean;
}) {
  return (
    <section className={styles.pricingSection}>
      {dropTrail && <DropTrail />}
      <div className={styles.sectionInner}>
        <Reveal>
          <SectionHeader
            title={
              <>
                {title}
                <br />
                <span className={styles.titleAccent}>{accent}</span>
              </>
            }
            lead={lead}
          />
        </Reveal>
        <Reveal className={styles.buttonRow} delay={60}>
          <Button href={LIVE_PRICES_URL} variant="ghost" arrow>Live prices</Button>
        </Reveal>
        <PriceBoard />
        <Reveal className={styles.payNote} delay={160}>
          <img src="/img/home/icon-shield-sm.svg" alt="" width="24" height="24" />
          You only pay for what you use. Settlement goes straight to the provider, in USDC on Base.
        </Reveal>
      </div>
    </section>
  );
}
