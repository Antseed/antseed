import {useEffect, useRef, useState, type JSX} from 'react';
import clsx from 'clsx';
import {Wash} from '../../../components';
import {panelId, stackIndex, tabId} from './PointList';
import type {PrivacyPoint} from './points';
import {PrivacyWindow} from './PrivacyWindow';
import styles from './Privacy.module.css';

type Props = {point: PrivacyPoint; index: number; on: boolean; stacked: boolean};

/**
 * A point's panel: its painting and its screen. All four share one cell and cross-fade; a newly chosen one arrives again. Stacked, each
 * stands under its name and arrives once, as it comes into view.
 */
export function PointPanel({point, index, on, stacked}: Props): JSX.Element {
  const [arrivals, setArrivals] = useState(0);
  const was = useRef(on);
  useEffect(() => {
    if (on && !was.current && !stacked) setArrivals((n) => n + 1);
    was.current = on;
  }, [on, stacked]);
  return (
    <div
      className={clsx(styles.slot, on && styles.on)}
      style={stackIndex(index)}
      role={stacked ? 'region' : 'tabpanel'}
      id={panelId(point)}
      aria-labelledby={tabId(point)}
      inert={!on}
      data-panel=""
      data-on={on ? '' : undefined}
      data-rv={stacked ? 'panel' : undefined}>
      <Wash unveil replayKey={arrivals} className={styles.panel} {...point.painting}>
        <PrivacyWindow window={point.window} />
      </Wash>
    </div>
  );
}
