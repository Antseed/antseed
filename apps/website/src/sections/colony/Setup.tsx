import type {JSX} from 'react';
import {Button, Section, SectionHead} from '../../components';
import {DOWNLOAD_URL} from './config';
import styles from './Setup.module.css';

type Step = {lead: string; text: string};

const STEPS: readonly Step[] = [
  {lead: 'Install.', text: 'Open the download and drag Antseed Colony to Applications.'},
  {lead: 'Join the Colony.', text: 'Paste the Colony’s address from your invite and choose Join. The app downloads the model the Colony runs and starts serving.'},
  {lead: 'Link your wallet.', text: 'Choose Link wallet, connect your wallet and confirm once. What your Mac earns goes there from then on.'},
];

/** Invited? The head on the left, the three numbered steps on the right (stacked on phones). The app isn't public yet: the download
 *  button waits for config.ts's downloadUrl, and until then the line under the head says it comes with the invite. */
export default function Setup(): JSX.Element {
  return (
    <Section cmp="colony/setup" id="setup" labelledBy="setup-title" className={styles.setup} railClassName={styles.rail}>
      <div className={styles.text}>
        <SectionHead
          size="compact"
          eyebrow="Invited?"
          title={['Set up your Mac', 'in three steps.']}
          id="setup-title"
          sub="Once you’re invited, download Antseed Colony, join with the address from your invite, and link the wallet your earnings go to."
          className={styles.head}
          subClassName={styles.sub}
        />
        <div className={styles.foot} data-rv="">
          {DOWNLOAD_URL && <Button href={DOWNLOAD_URL} size="page">Download for Mac</Button>}
          <p className={styles.note}>The download comes with your invite. Apple silicon, macOS 14 or later.</p>
        </div>
      </div>
      <ol className={styles.steps} data-rv="">
        {STEPS.map((step, i) => (
          <li key={step.lead} className={styles.step}>
            <span className={styles.number} aria-hidden="true">{i + 1}</span>
            <p className={styles.copy}><b>{step.lead}</b> {step.text}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
