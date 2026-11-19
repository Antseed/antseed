import {useColorMode} from '@docusaurus/theme-common';
import {PAINTINGS} from '../../lib/paintings';
import styles from './NetworkBoard.module.css';

// A square of watercolour folded onto each diamond's two isometric axes.
// objectBoundingBox keeps the print attached when the plates move between steps.
// An SVG <image> can't load lazily, so the prints are left out until the board is near (`load`), and only the theme on screen
// is drawn: otherwise the six full paintings download with the first screen and hold up the hero on a slow phone.
export function PaintedLayers({load}: {load: boolean}) {
  const {colorMode} = useColorMode();
  return <svg width="0" height="0" className={styles.swatches} aria-hidden="true" focusable="false"><defs>
    {(['clover', 'pond', 'ferns'] as const).map(name => (
      <pattern key={name} id={`network-print-${name}`} x="0" y="0" width="1" height="1" viewBox="0 0 100 100" preserveAspectRatio="none">
        <rect width="100" height="100" fill="var(--face-top)" />
        {load && <g transform="matrix(.5 .5 -.5 .5 50 0)" opacity=".36">
          <image width="100" height="100" preserveAspectRatio="xMidYMax slice" href={PAINTINGS[name][colorMode === 'dark' ? 'night' : 'day']} />
        </g>}
      </pattern>
    ))}
  </defs></svg>;
}
