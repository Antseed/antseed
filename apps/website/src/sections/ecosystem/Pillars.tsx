import type {JSX} from 'react';
import {Section, SectionHead} from '../../components';
import {PixelIcon} from '../../parts/PixelIcon';
import {PILLARS, type Pillar} from './directory';
import styles from './Ecosystem.module.css';

function PillarTile({pillar}: {pillar: Pillar}): JSX.Element {
  return (
    <div className={styles.tile}>
      <PixelIcon name={pillar.icon} className={styles.icon} />
      <h3 className={styles.tileName}>{pillar.name}</h3>
      <p className={styles.tileLine}>{pillar.line}</p>
    </div>
  );
}

/** Four ways to plug in. */
export default function Pillars(): JSX.Element {
  return (
    <Section cmp="ecosystem/pillars" labelledBy="pillars-title" className={styles.section} railClassName={styles.rail} pad="y">
      <SectionHead
        padX
        className={styles.head}
        titleClassName={styles.title}
        subClassName={styles.sub}
        eyebrow="Ecosystem pillars"
        title={['Where builders', 'can plug in.']}
        id="pillars-title"
        sub="From dashboards to managed AI products, the network expands when each layer gets easier to discover and use."
      />
      <div className={styles.tiles}>
        {PILLARS.map((p) => <PillarTile key={p.name} pillar={p} />)}
      </div>
    </Section>
  );
}
