import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import styles from '../pages/index.module.css';
import {Reveal, ArrowRight} from './ui';

export interface PrivacyCard {
  text: ReactNode;
  /** "Learn more" target */
  to: string;
}

const ANONYMOUS_DEFAULT: PrivacyCard = {
  text: 'No account or email needed, so neither the provider nor Antseed knows who sent the request.',
  to: '/blog/trust-without-a-middleman',
};

const PRIVATE_DEFAULT: PrivacyCard = {
  text: 'Choose a TEE-verified provider. Your request runs in a secure enclave, keeping your prompt hidden – even from the provider.',
  to: '/blog/dont-trust-the-tee-label',
};

/**
 * The "Anonymous / Private" panel from the homepage — ghost title over the
 * dark spy card and the green shield card. Shared with /privacy, /coding and
 * /agents; the title and the two card texts change per audience.
 */
export function PrivacyPanel({
  title,
  anonymous = ANONYMOUS_DEFAULT,
  privateCard = PRIVATE_DEFAULT,
}: {
  title: ReactNode;
  anonymous?: PrivacyCard;
  privateCard?: PrivacyCard;
}) {
  return (
    <section className={styles.privacyWrap}>
      <div className={styles.privacyPanel}>
        <img className={styles.privacyDotsLeft} src="/img/home/antdots-w.png" alt="" aria-hidden="true" />
        <img className={styles.privacyDotsRight} src="/img/home/antdots-w.png" alt="" aria-hidden="true" />
        <Reveal>
          <h2 className={styles.privacyGhostTitle}>{title}</h2>
        </Reveal>
        <div className={styles.privacyGrid}>
          <Reveal className={styles.privacyCardDark}>
            <img className={styles.privacySpy} src="/img/home/spy-dots.png" alt="" aria-hidden="true" />
            <div className={styles.privacyCopy}>
              <h3>Anonymous</h3>
              <p>{anonymous.text}</p>
              <Link to={anonymous.to} className={styles.privacyMore}>
                Learn more
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
          <Reveal className={styles.privacyCardGreen} delay={110}>
            <img className={styles.privacyShield} src="/img/home/shield-dots.png" alt="" aria-hidden="true" />
            <div className={styles.privacyCopyGreen}>
              <h3>Private</h3>
              <p>{privateCard.text}</p>
              <Link to={privateCard.to} className={styles.privacyMore}>
                Learn more
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
