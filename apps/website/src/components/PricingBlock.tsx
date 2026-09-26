import type {ReactNode} from 'react';
import styles from '../pages/index.module.css';
import {Button, Reveal, SectionHeader} from './ui';
import {PriceBoard} from './PriceBoard';

/**
 * The pricing section as a whole — drop-trail dots, two-line title with the
 * green second line, lead, the "Live prices" button, the live price board
 * and the settlement note. Shared by the homepage, /agents and /coding so
 * the three stay identical; only the copy differs. The download button
 * lives in the hero and the closing band, not here.
 */

const DROP_TRAIL_DOTS = Array.from({length: 11}, (_, i) => 3 + i * 8);
const DROP_TRAIL_CYCLE = 1.6;

export const LIVE_PRICES_URL = 'https://antseedstats.com/network';

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
      {dropTrail && (
        <div className={styles.dropTrail} aria-hidden="true">
          <img src="/img/home/dots-down.svg" alt="" className={styles.dropTrailLine} />
          {DROP_TRAIL_DOTS.map((top, i) => {
            // Line asset fades in top-to-bottom (transparent at y=3, solid
            // at y=91) — each dot's peak brightness follows that same ramp.
            const peak = 0.25 + 0.75 * ((top - 3) / 88);
            return (
              <span
                key={i}
                className={styles.dropTrailDot}
                style={{
                  top,
                  animationDelay: `${i * (DROP_TRAIL_CYCLE / DROP_TRAIL_DOTS.length)}s`,
                  ['--dot-peak' as string]: peak,
                }}
              />
            );
          })}
        </div>
      )}
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
