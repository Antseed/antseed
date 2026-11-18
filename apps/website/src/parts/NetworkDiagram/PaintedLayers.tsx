import {PAINTINGS} from '../../lib/paintings';
import styles from './NetworkBoard.module.css';

// A square of watercolour folded onto each diamond's two isometric axes.
// objectBoundingBox keeps the print attached when the plates move between steps.
export function PaintedLayers() {
  return <svg width="0" height="0" className={styles.swatches} aria-hidden="true" focusable="false"><defs>
    {(['clover', 'pond', 'ferns'] as const).map(name => (
      <pattern key={name} id={`network-print-${name}`} x="0" y="0" width="1" height="1" viewBox="0 0 100 100" preserveAspectRatio="none">
        <rect width="100" height="100" fill="var(--face-top)" />
        <g transform="matrix(.5 .5 -.5 .5 50 0)" opacity=".36">
          <image width="100" height="100" preserveAspectRatio="xMidYMax slice" href={PAINTINGS[name].day} className={styles.dayPrint} />
          <image width="100" height="100" preserveAspectRatio="xMidYMax slice" href={PAINTINGS[name].night} className={styles.nightPrint} />
        </g>
      </pattern>
    ))}
  </defs></svg>;
}
