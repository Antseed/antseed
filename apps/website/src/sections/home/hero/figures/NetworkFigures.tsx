import type {JSX} from 'react';
import {Tally} from '../../../../components';
import {useMarket, useNetworkTotals} from '../../../../lib/antscan';
import {formatFigure, type Figure} from '../data';
import styles from './NetworkFigures.module.css';

/** Lifetime buyers, tokens served (paid and free) and the registered sellers, live from Antscan's totals; the distinct models on offer
 *  as of the build (the market read is too heavy for the first screen; the price board below reads it live). */
function useFigures(): Figure[] {
  const totals = useNetworkTotals();
  const {models} = useMarket();
  return [
    {label: 'Active users', value: formatFigure(totals.users)},
    {label: 'Tokens consumed', value: formatFigure(totals.tokens)},
    {label: 'Models', value: formatFigure(models)},
    {label: 'Providers', value: formatFigure(totals.providers)},
  ];
}

/** The band under the hero: the network's figures, each a small label over its value. */
export function NetworkFigures(): JSX.Element {
  const figures = useFigures();
  return (
    <div className={styles.band} data-cmp="home/backers">
      {figures.map((f) => (
        <div key={f.label} className={styles.figure}>
          <p className={styles.label}>{f.label}</p>
          <Tally value={f.value} className={styles.value} />
        </div>
      ))}
    </div>
  );
}
