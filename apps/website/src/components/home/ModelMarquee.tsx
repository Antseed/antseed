import {useEffect, useRef, useState} from 'react';
import {VENDOR_GLYPHS} from '../PriceBoard';
import {useMarketplaceShowcase, type ShowcaseRow} from '../../lib/useMarketplacePrices';
import styles from './LaunchHero.module.css';

/**
 * MODEL MARQUEE — two rows of model cards drifting in opposite directions,
 * each with how much the lowest live price on the network saves against the
 * official API price (input tokens), and that price per million tokens.
 * Models saving 50% or more are picked first.
 *
 * Rows come from useMarketplaceShowcase (the same feed as the price board),
 * which renders its dated snapshot during SSR, so the cards and prices are
 * in the static HTML. Motion is CSS only: each row is two identical runs
 * (the second aria-hidden) sliding by half their width. Paused on hover,
 * while scrolled out of view, and for reduced motion.
 */

/** Cards per run: wider than the viewport, so the loop never shows a gap,
    and fixed, so swapping the snapshot for live prices never changes the
    run's width (no layout shift). */
const PER_RUN = 10;

function fill(rows: ShowcaseRow[]): ShowcaseRow[] {
  if (!rows.length) return rows;
  const out: ShowcaseRow[] = [];
  while (out.length < PER_RUN) out.push(...rows);
  return out.slice(0, PER_RUN);
}

function ModelCard({row}: {row: ShowcaseRow}) {
  const Glyph = VENDOR_GLYPHS[row.vendorKey];
  const free = row.bestUsd === 0;
  return (
    <div className={styles.modelCard} title={`${row.best}/M on Antseed vs ${row.official}/M official API price`}>
      <span className={styles.modelLogo}>{Glyph ? <Glyph size={20} /> : null}</span>
      <span className={styles.modelText}>
        <strong>{row.model}</strong>
        <em>{row.vendor}</em>
      </span>
      <span className={styles.modelPrice}>
        <strong>{free ? 'Free' : `−${row.save}`}</strong>
        {!free && (
          <span>
            {row.best}
            <small>/M</small>
          </span>
        )}
      </span>
    </div>
  );
}

function Track({rows, reverse}: {rows: ShowcaseRow[]; reverse?: boolean}) {
  return (
    <div className={`${styles.track} ${reverse ? styles.trackReverse : ''}`}>
      {[0, 1].map((copy) => (
        <div key={copy} className={styles.run} aria-hidden={copy === 1 || undefined}>
          {rows.map((row, i) => (
            <ModelCard key={`${row.model}-${i}`} row={row} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ModelMarquee() {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(true);
  const rows = useMarketplaceShowcase(10, {minSave: 50});

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const half = Math.ceil(rows.length / 2);
  const rowA = fill(rows);
  const rowB = fill([...rows.slice(half), ...rows.slice(0, half)]);

  return (
    <section
      ref={ref}
      className={styles.marquee}
      data-paused={visible ? undefined : ''}
      aria-label="Model prices on Antseed: saving against the official API price, and the lowest live price per million input tokens">
      <Track rows={rowA} />
      <Track rows={rowB} reverse />
    </section>
  );
}
