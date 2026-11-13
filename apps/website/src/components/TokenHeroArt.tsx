import styles from './TokenHeroArt.module.css';
import {INITIAL_EMISSION, MAX_SUPPLY, useEpochCountdown} from '../lib/useEpochCountdown';
import {useAntsSupply} from '../lib/useAntsSupply';

/**
 * /ants-token hero panel. Real data only: the epoch clock (weekly epochs
 * from the emissions genesis), total supply and burned amount read live from
 * the ANTS contract on Base, and the scheduled emission for the current epoch
 * (5M ANTS, halving every 104 epochs).
 */

const HALVING_EPOCHS = 104;

function fmt(n: number, digits = 1): string {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString('en-US', {maximumFractionDigits: 2})}B`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('en-US', {maximumFractionDigits: digits})}M`;
  if (n >= 1e3) return `${(n / 1e3).toLocaleString('en-US', {maximumFractionDigits: 0})}k`;
  return n.toLocaleString('en-US', {maximumFractionDigits: 0});
}

/** Live total supply when available, otherwise the emission schedule (null before the clock starts). */
function totalSupply(live: {total: number} | null, started: boolean, epoch: number): number | null {
  if (live) return live.total;
  if (started) return epoch * INITIAL_EMISSION;
  return null;
}

export function TokenHeroArt() {
  const {epoch, timeLeft, progress, started} = useEpochCountdown();
  const live = useAntsSupply();
  const total = totalSupply(live, started, epoch);
  const pct = total === null ? 0 : (total / MAX_SUPPLY) * 100;
  const emission = started ? INITIAL_EMISSION / 2 ** Math.floor(epoch / HALVING_EPOCHS) : null;

  return (
    <div className={styles.well}>
      <div className={styles.panel} role="img" aria-label="Live ANTS supply and epoch clock">
        <div className={styles.bar}>
          <span>
            Epoch <strong>{started ? epoch : '–'}</strong>
          </span>
          <span className={styles.epochTrack} aria-hidden="true">
            <span className={styles.epochFill} style={{width: `${Math.round(progress * 100)}%`}} />
          </span>
          <span>
            Next in <strong>{timeLeft}</strong>
          </span>
        </div>

        <div className={styles.supply}>
          <span className={styles.supplyLabel}>
            Total supply
            {live && <i className={styles.liveDot} aria-hidden="true" />}
          </span>
          <span className={styles.supplyValue}>{total === null ? '–' : fmt(total)} ANTS</span>
          <span className={styles.supplyTrack} aria-hidden="true">
            <span className={styles.supplyFill} style={{width: `${Math.max(pct, 0.3)}%`}} />
          </span>
          <span className={styles.supplySub}>
            {total === null ? '–' : `${pct.toFixed(1)}%`} of the 1.04B hard cap
          </span>
        </div>

        <div className={styles.grid}>
          <div className={styles.term}>
            <span className={styles.termLabel}>Hard cap</span>
            <span className={styles.termValue}>{fmt(MAX_SUPPLY)}</span>
          </div>
          <div className={styles.term}>
            <span className={styles.termLabel}>Burned</span>
            <span className={styles.termValue}>{live ? fmt(live.burned) : '–'}</span>
          </div>
          <div className={styles.term}>
            <span className={styles.termLabel}>This epoch</span>
            <span className={styles.termValue}>{emission === null ? '–' : fmt(emission)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
