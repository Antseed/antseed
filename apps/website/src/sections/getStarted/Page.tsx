import type {JSX} from 'react';
import {PageMetadata} from '@docusaurus/theme-common';
import {Intro} from './Intro';
import {Instructions} from './Instructions';
import {useStep} from './useStep';
import styles from './GetStarted.module.css';

/**
 * /get-started: where the site's Antseed Desktop buttons send a phone. Antseed runs on a computer, so the phone path creates a
 * Telegram bot now and pastes its token into Antseed Desktop later. A bare, focused flow without the site's nav and footer.
 */
export default function Page(): JSX.Element {
  const {step, back} = useStep();
  return (
    <main className={styles.page}>
      <PageMetadata
        title="Get started"
        description="Get on the Antseed network from your phone: create a Telegram bot now, paste the token into Antseed Desktop on your computer later."
      />
      {step === 1 ? <Intro /> : <Instructions onBack={back} />}
    </main>
  );
}
