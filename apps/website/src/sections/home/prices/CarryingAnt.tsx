import type {JSX} from 'react';
import clsx from 'clsx';
import styles from './CarryingAnt.module.css';

/**
 * The ant hauling a card, as three layers inside the card: the ant behind the card's tile, its hand over the card's edge, and its
 * shadow on the ground. Its sheet and cell come from CSS variables on the card (carryGeometry); useCarriers steps the frames.
 * `ahead`: the whole ant walks in front of its card instead.
 */
export function CarryingAnt({mirrored, ahead}: {mirrored: boolean; ahead: boolean}): JSX.Element {
  const cls = clsx(mirrored && styles.mirrored, ahead && styles.ahead);
  return (
    <>
      <i className={clsx(styles.ant, cls)} data-layer="back" aria-hidden="true" />
      <i className={clsx(styles.ant, styles.hand, cls)} data-layer="hand" aria-hidden="true" />
      <i className={clsx(styles.shade, cls)} data-layer="shade" aria-hidden="true" />
    </>
  );
}
