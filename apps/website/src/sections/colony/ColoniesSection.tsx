import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import {Section, SectionHead} from '../../components';
import {usePlayOnView} from '../../lib/usePlayOnView';
import ColonyPathCard from './ColonyPathCard';
import {PATHS} from './paths';
import styles from './Colonies.module.css';

/** The cards rise in once a fifth of the grid is in view. */
const RISE_AT = 0.2;

/** Two ways in: join the Mac Colony, or (soon) build one. */
export default function Colonies(): JSX.Element {
  const grid = useRef<HTMLDivElement>(null);
  const pending = usePlayOnView(grid, RISE_AT);
  return (
    <Section cmp="colony/colonies" id="colonies" labelledBy="colonies-title" className={styles.colonies} railClassName={styles.rail}>
      <SectionHead
        padX
        size="compact"
        eyebrow="Colonies"
        title={['Find your place', 'in a Colony.']}
        id="colonies-title"
        sub="Join the Mac Colony, or build a new one."
        className={styles.head}
      />
      <div ref={grid} className={clsx(styles.grid, pending && styles.pending)}>
        {PATHS.map((path) => <ColonyPathCard key={path.name} path={path} />)}
      </div>
    </Section>
  );
}
