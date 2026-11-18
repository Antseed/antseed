import type {JSX} from 'react';
import {Actions, Button, Duo, DuoHead, Eyebrow, Heading, Sub, Wash} from '../../components';
import {SIGN_UP_HREF} from './signUpLinks';
import styles from './FirstColony.module.css';

type Fact = {term: string; detail: string};

const FACTS: readonly Fact[] = [
  {term: 'Who goes first', detail: 'Mac Studios with 256 GB of memory or more, and 512 GB is ideal. Anyone with a Mac can sign up, and we choose who starts first.'},
  {term: 'How it starts', detail: 'Early members join a small private group with the Antseed team, set up their Mac with us and help shape what comes next.'},
  {term: 'What it runs', detail: 'One strong open model, served by every Mac in the Colony.'},
];

/** Who goes first, how it starts and what it runs, beside the anthill. */
export default function FirstColony(): JSX.Element {
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
          day="/site/assets/colony/first-day.webp"
          night="/site/assets/colony/first-night.webp"
          label="Four ants on an anthill. One stands on a Mac Studio at the top and plants a lime flag. Two more carry crumbs up the slope."
        />
      }
      text={<>
        <Eyebrow className={styles.eyebrow}>The first Mac Colony</Eyebrow>
        <DuoHead className={styles.head}>
          <Heading as="h2" id="first-title" strong secondLine="break" title={['Mac Studios', 'go first.']} className={styles.title} />
          <Sub className={styles.sub}>Early access is invite-only while we test.</Sub>
        </DuoHead>
        <dl className={styles.facts}>
          {FACTS.map((f) => <div key={f.term} className={styles.fact}><dt className={styles.term}>{f.term}</dt><dd className={styles.detail}>{f.detail}</dd></div>)}
        </dl>
        <Actions fill className={styles.actions}><Button href={SIGN_UP_HREF} size="page">Sign up for early access</Button></Actions>
      </>}
    />
  );
}
