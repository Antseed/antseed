import type {JSX} from 'react';
import {Actions, Button, Duo, DuoHead, Eyebrow, Heading, Wash} from '../../components';
import {useJoinHref} from './useColony';
import styles from './FirstColony.module.css';

type Fact = {term: string; detail: string};

const FACTS: readonly Fact[] = [
  {term: 'Who can join', detail: 'Any Mac with Apple silicon. Sign up, and we’ll invite Macs from the waitlist in small groups as the Colony grows.'},
  {term: 'How it starts', detail: 'Early members set up their Mac with the Antseed team and help shape what comes next. It starts in Local AI Colony, our local AI group on Telegram.'},
  {term: 'What it runs', detail: 'One strong open model, served by every Mac in the Colony.'},
];

/** Who can join, how it starts and what it runs, beside the anthill. No line says which Macs go first: the waitlist's order stays with
 *  the team. */
export default function FirstColony(): JSX.Element {
  const join = useJoinHref();
  return (
    <Duo
      snap="narrow"
      cmp="colony/first"
      id="first"
      labelledBy="first-title"
      flip
      className={styles.first}
      railClassName={styles.rail}
      textClassName={styles.text}
      panel={
        <Wash
          unveil
          reveal="panel"
          className={styles.painting}
          day="/site/assets/colony/first-mixed-day.webp"
          night="/site/assets/colony/first-mixed-night.webp"
          label="Four ants on an anthill. A laptop, a Mac mini and a Mac Studio stand side by side on top, and one ant plants a small lime pennant beside them. Two more climb the slope."
        />
      }
      text={<>
        <Eyebrow className={styles.eyebrow}>The first Mac Colony</Eyebrow>
        <DuoHead className={styles.head}>
          <Heading as="h2" id="first-title" strong secondLine="break" title={['Built with', 'its first members.']} className={styles.title} />
        </DuoHead>
        <dl className={styles.facts}>
          {FACTS.map((f) => <div key={f.term} className={styles.fact}><dt className={styles.term}>{f.term}</dt><dd className={styles.detail}>{f.detail}</dd></div>)}
        </dl>
        <Actions fill className={styles.actions}><Button href={join} size="page">Join the waitlist</Button></Actions>
      </>}
    />
  );
}
