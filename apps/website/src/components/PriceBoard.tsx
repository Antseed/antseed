import type {ReactNode} from 'react';
import {
  Anthropic,
  OpenAI,
  Google,
  DeepSeek,
  Meta,
  Qwen,
  Mistral,
  Moonshot,
  Zhipu,
  Minimax,
  Cohere,
  NousResearch,
  XiaomiMiMo,
  Tencent,
  Stepfun,
  Nvidia,
  XAI,
} from '@lobehub/icons';
import styles from '../pages/index.module.css';
import {Reveal, ArrowRight} from './ui';
import {useMarketplaceShowcase} from '../lib/useMarketplacePrices';

/**
 * The live "Official API Price vs Best price" board from the homepage,
 * shared so other pages (e.g. /agents) can show the same rows. Rows come
 * from useMarketplaceShowcase; styles from the homepage module so the two
 * never drift.
 */

type IconSize = (props: {size?: number}) => ReactNode;

export const VENDOR_GLYPHS = {
  Anthropic,
  OpenAI,
  Google,
  DeepSeek,
  Meta,
  Qwen,
  Mistral,
  Moonshot,
  Zhipu,
  Minimax,
  Cohere,
  NousResearch,
  XiaomiMiMo,
  Tencent,
  Stepfun,
  Nvidia,
  XAI,
} as unknown as Record<string, IconSize>;

/* hugeicons:checkmark (12) */
function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.25 6.93002L3.6747 8.35472C4.07982 8.75985 4.74183 8.74244 5.1251 8.31658L10 2.90002" />
    </svg>
  );
}

export function PriceBoard({count = 4, delay = 120}: {count?: number; delay?: number}) {
  const rows = useMarketplaceShowcase(count);
  return (
    <Reveal className={styles.priceCard} delay={delay}>
      <img className={styles.priceAnt} src="/img/home/antdots-b.png" alt="" aria-hidden="true" />
      <div className={styles.priceHead}>
        <span>Official API Price</span>
        <a
          className={styles.priceLive}
          href="https://antseedstats.com/network"
          target="_blank"
          rel="noopener noreferrer">
          <span className={styles.signalDots} aria-hidden="true"><i /><i /><i /></span>
          Live prices
          <span className={styles.priceLiveArrow}><ArrowRight /></span>
        </a>
      </div>
      <div className={styles.priceRows}>
        {rows.map((row) => {
          const Glyph = VENDOR_GLYPHS[row.vendorKey];
          return (
            <div key={row.model} className={styles.priceRow}>
              <span className={styles.priceLogo}>{Glyph ? <Glyph size={22} /> : null}</span>
              <span className={styles.priceModel}>
                <strong>{row.model}</strong>
                <em>{row.vendor}</em>
              </span>
              <span className={styles.priceOfficial}>
                <s>{row.official}</s>
                <em>/M tokens</em>
              </span>
              <span className={styles.priceBest}>
                <span className={styles.priceBestTop}>
                  <strong>{row.best}</strong>
                  <i className={styles.bestBadge}><CheckIcon /> Best price</i>
                </span>
                <span className={styles.priceBestSub}>/M tokens</span>
              </span>
              <span className={styles.priceSave}>
                <strong>{row.save}</strong>
                <em>Save</em>
              </span>
            </div>
          );
        })}
      </div>
    </Reveal>
  );
}
