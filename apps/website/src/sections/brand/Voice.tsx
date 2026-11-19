import type {JSX} from 'react';
import {Section, SectionHead} from '../../components';
import {Point, PointCaption, PointsRow} from '../../parts/PointsRow';
import styles from './Voice.module.css';

const RULES = [
  {name: 'Two-part titles.', text: 'A sentence in two halves, the second in grey, ending in a full stop. The H1 alone has none.'},
  {name: 'Sentence case.', text: 'No capitals for emphasis, no italics, no all-caps labels.'},
  {name: 'Real numbers.', text: 'Never invent a figure, a model or a price: every number comes from AntSeedStats.'},
] as const;

/** How the brand writes. */
export default function Voice(): JSX.Element {
  return (
    <Section cmp="brand/voice" id="voice" labelledBy="voice-title" railClassName={styles.rail}>
      <SectionHead
        padX
        className={styles.head}
        eyebrow="Voice"
        id="voice-title"
        title={['Plain words,', 'said once.']}
        sub="Every page has two halves: the layout says what Antseed sells within two seconds, the paintings and the ant make it friendly. Neither swallows the other."
      />
      <PointsRow className={styles.row}>
        {RULES.map((r) => (
          <Point key={r.name} className={styles.point}>
            <PointCaption name={r.name}>{r.text}</PointCaption>
          </Point>
        ))}
      </PointsRow>
    </Section>
  );
}
