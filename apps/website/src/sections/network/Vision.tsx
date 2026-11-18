import type {JSX} from 'react';
import {Section, SectionHead} from '../../components';
import {Point, PointCaption, PointsRow} from '../../parts/PointsRow';
import styles from './Vision.module.css';

const PRINCIPLES = [
  {name: 'Open.', text: 'Anyone can buy or provide intelligence.'},
  {name: 'Direct.', text: 'Buyers connect straight to providers, who set their own offers and prices.'},
  {name: 'Earned trust.', text: 'Providers build reputation through the quality of their service.'},
  {name: 'Privacy.', text: 'People choose the level of privacy they need.'},
] as const;

/** Our vision, then its four principles. */
export default function Vision(): JSX.Element {
  return (
    <Section cmp="network/vision" labelledBy="vision-title" className={styles.vision} railClassName={styles.rail}>
      <SectionHead
        padX
        className={styles.head}
        eyebrow="Our vision"
        id="vision-title"
        title={['Every computer a provider.', 'Every agent a customer.']}
        sub="As open models get cheaper to run, more people and companies will run AI on their own computers and servers. A single Mac, a GPU fleet, a pool of Macs like Colony or another whole network can each join as a provider. Antseed is the network where they find buyers."
      />
      <PointsRow className={styles.principles}>
        {PRINCIPLES.map((p) => (
          <Point key={p.name} className={styles.principle}>
            <PointCaption name={p.name} className={styles.caption}>{p.text}</PointCaption>
          </Point>
        ))}
      </PointsRow>
    </Section>
  );
}
