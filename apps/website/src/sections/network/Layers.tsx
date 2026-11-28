import type {JSX} from 'react';
import {Section, SectionHead} from '../../components';
import NetworkDiagram from '../../parts/NetworkDiagram/NetworkDiagram';
import styles from './Layers.module.css';

/** The network in three connected layers: the animated board and its three steps. */
export default function Layers(): JSX.Element {
  return (
    <Section cmp="network/layers" labelledBy="layers-title" className={styles.layers} railClassName={styles.rail}>
      <SectionHead
        padX
        id="layers-title"
        titleClassName={styles.title}
        title={[<>A fully <span className={styles.nobreak}>peer-to-peer</span> network.</>, 'In three connected layers.']}
        sub="Many users and many independent providers, connected directly. No central Antseed server."
      />
      <NetworkDiagram boardClassName={styles.board} pointClassName={styles.point} />
    </Section>
  );
}
