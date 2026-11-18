import type {JSX} from 'react';
import {Section, SectionHead, Wash} from '../../components';
import MacFitForm from './MacFitForm';
import styles from './Join.module.css';

/** The closing sign-up: the line on the painting's sky, then where your Mac fits. */
export default function Join(): JSX.Element {
  return (
    <Section cmp="colony/join" id="join" labelledBy="join-title" className={styles.join} railClassName={styles.rail}>
      <div className={styles.scene}>
        <SectionHead
          center
          eyebrow="Sign up"
          eyebrowClassName={styles.eyebrow}
          title={['Your Mac has a place', 'in the Colony.']}
          id="join-title"
          sub="Tell us which Mac you have, its chip and its memory. We’ll reach out with an invite to the early group."
          subClassName={styles.sub}
          className={styles.head}
        />
        <Wash
          unveil
          className={styles.painting}
          day="/site/assets/colony/join-day.webp"
          night="/site/assets/colony/join-night.webp"
          label="By night, three ants stand behind their Mac Studios on a plank while a fourth carries its Mac Studio to the empty space at the end."
        />
      </div>
      <MacFitForm />
    </Section>
  );
}
