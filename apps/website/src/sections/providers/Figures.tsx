import type {JSX} from 'react';
import {Section, Tally} from '../../components';
import {useNetworkTotals, type NetworkTotals} from '../../lib/antscan';
import styles from './Figures.module.css';

/** 24_700_000 → "24.7M"; with `money`, thousands too and a "$": 397_100 → "$397.1K". Under a thousand, grouped whole numbers. */
function compact(n: number, money = false): string {
  const [unit, suffix] = n >= 1e9 ? [1e9, 'B'] : n >= 1e6 ? [1e6, 'M'] : money && n >= 1e3 ? [1e3, 'K'] : [1, ''];
  const body = unit === 1 ? Math.round(n).toLocaleString('en-US') : (n / unit).toFixed(1) + suffix;
  return (money ? '$' : '') + body;
}

type Figure = {label: string; value: (t: NetworkTotals) => string};

const FIGURES: readonly Figure[] = [
  {label: 'Active users', value: (t) => compact(t.users)},
  {label: 'Requests served', value: (t) => compact(t.requests)},
  {label: 'USDC settled', value: (t) => compact(t.settledUsd, true)},
  {label: 'Providers', value: (t) => compact(t.providers)},
];

/** The network today, under the first screen: Antscan's lifetime figures, as built and then as read live. */
export function Figures(): JSX.Element {
  const totals = useNetworkTotals();
  return (
    <Section cmp="providers/figs" label="The network today">
      <div className={styles.band}>
        {FIGURES.map(({label, value}) => (
          <div key={label} className={styles.figure}>
            <p className={styles.label}>{label}</p>
            <Tally className={styles.value} value={value(totals)} />
          </div>
        ))}
      </div>
    </Section>
  );
}
