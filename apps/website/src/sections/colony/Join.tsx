import type {JSX} from 'react';
import {Actions, Button, Section, SectionHead, Wash} from '../../components';
import {TELEGRAM_URL} from './config';
import {useJoinHref} from './useColony';
import styles from './Join.module.css';

/** The waitlist, before the FAQ: the closing line, its two buttons, then the painting. Sign-ups happen on /colony/join/ (one question
 *  at a time, then the Google Form), so there is one list; the Telegram button shows once config.ts has its link. */
export default function Join(): JSX.Element {
  const join = useJoinHref();
  return (
    <Section cmp="colony/join" id="join" labelledBy="join-title" className={styles.join} railClassName={styles.rail}>
      <div className={styles.scene}>
        <SectionHead
          center
          eyebrow="Waitlist"
          eyebrowClassName={styles.eyebrow}
          title={['Your Mac has a place', 'in the Colony.']}
          id="join-title"
          sub="Leave your email and tell us which Mac you have. We’ll email you when there’s a spot for it."
          subClassName={styles.sub}
          className={styles.head}>
          <Actions fill reveal className={styles.cta}>
            <Button href={join} size="page">Join the waitlist</Button>
            {TELEGRAM_URL && <Button href={TELEGRAM_URL} variant="ghost" size="page">Join Local AI Colony on Telegram</Button>}
          </Actions>
        </SectionHead>
        <Wash
          unveil
          className={styles.painting}
          day="/site/assets/colony/join-mixed-day.webp"
          night="/site/assets/colony/join-mixed-night.webp"
          label="Three ants stand behind their Macs on a plank while a fourth carries its own laptop to the empty space at the end."
        />
      </div>
    </Section>
  );
}
