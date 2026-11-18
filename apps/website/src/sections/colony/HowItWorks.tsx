import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import {Section, SectionHead, Wash} from '../../components';
import {Point, PointCaption, PointsRow} from '../../parts/PointsRow';
import {usePlayOnView} from '../../lib/usePlayOnView';
import styles from './HowItWorks.module.css';

type Step = {lead: string; text: string};

const STEPS: readonly Step[] = [
  {lead: 'Your Mac joins.', text: 'Antseed Colony is a menu bar app. Your Mac joins a Colony and downloads the model it runs.'},
  {lead: 'The Colony works as one provider.', text: 'Each request goes to a Mac in the Colony that can answer it, and faster, steadier Macs get more of the work.'},
  {lead: 'Payments settle onchain.', text: 'Every payment a buyer signs names what it has paid your Mac, and the Colony’s contract splits each settlement between its Macs.'},
  {lead: 'You claim.', text: 'The app shows what your Mac has earned. Claim it to your own wallet when you like.'},
];
/** The steps come in once a third of the row is on screen. */
const STEPS_VISIBLE_SHARE = 0.35;

/** Many Macs serving as one provider: the painting, then the four steps. */
export default function HowItWorks(): JSX.Element {
  const row = useRef<HTMLDivElement>(null);
  const pending = usePlayOnView(row, STEPS_VISIBLE_SHARE);
  return (
    <Section cmp="colony/how" id="how" labelledBy="how-title" className={styles.how} railClassName={styles.rail}>
      <SectionHead
        padX
        size="compact"
        eyebrow="How it works"
        title={['Many machines.', 'One Colony.']}
        id="how-title"
        className={styles.head}
        sub="A Colony brings people’s computers together to serve AI on Antseed. To everyone using Antseed, it is one provider."
      />
      <Wash
        unveil
        className={styles.painting}
        day="/site/assets/colony/many-day.webp"
        night="/site/assets/colony/many-night.webp"
        label="A dozen Mac Studios stand together on a grassy hill, cabled to one another. Ants tend them, and two carry one more Mac Studio up to join the cluster."
      />
      <div ref={row} className={clsx(styles.steps, pending && styles.pending)}>
        <PointsRow className={styles.row}>
          {STEPS.map((step) => (
            <Point key={step.lead} className={styles.step}>
              <PointCaption name={step.lead} className={styles.caption}>{step.text}</PointCaption>
            </Point>
          ))}
        </PointsRow>
      </div>
    </Section>
  );
}
